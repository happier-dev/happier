package managedruntime

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestManagedWireProjectionAfterDeniedTool(t *testing.T) {
	for _, mode := range []struct {
		name    string
		options string
	}{
		{"off by default", `{}`},
		{"selected instance", `{"wireProjection":true}`},
	} {
		t.Run(mode.name, func(t *testing.T) {
			fixture := metaProtocolCases()[0]
			cfg := crossProtocolConfig(t, fixture)
			entry := cfg.AuthEntries[0]
			launch, err := json.Marshal(ManagedPurposeConfiguration{
				V: 3, ModelListEnabled: cfg.ModelListEnabled,
				Purposes: []ManagedPurposeConfigurationRow{{
					ID: entry.ID, Provider: entry.Provider, Consumer: entry.Purpose.Consumer, Purpose: entry.Purpose.Purpose,
					AllowedHTTPSOrigins: entry.AllowedHTTPSOrigins, Protocols: cfg.Protocols,
				}},
			})
			if err != nil {
				t.Fatal(err)
			}
			if mode.options != "{}" {
				launch = append(launch[:len(launch)-1], []byte(`,"wireProjection":true}`)...)
			}
			purposes, err := ParseManagedPurposeConfiguration(string(launch))
			if err != nil {
				t.Fatal(err)
			}
			cfg, err = ImmutableGatewayConfig(cfg.Host, cfg.Port, cfg.DownstreamBearer, cfg.RuntimeDir, purposes)
			if err != nil {
				t.Fatal(err)
			}
			broker := &sequenceBroker{leases: []RequestAuthHeaders{
				validLease("PRIVATE_UPSTREAM_CREDENTIAL", nil),
				validLease("PRIVATE_UPSTREAM_CREDENTIAL", nil),
				validLease("PRIVATE_UPSTREAM_CREDENTIAL", nil),
			}}
			upstream := &deniedToolWireFixture{}
			gateway, err := NewGateway(cfg, testRuntimeIdentity(), broker, upstream)
			if err != nil {
				t.Fatal(err)
			}
			cancel, runResult := runGateway(t, gateway)
			defer stopGateway(t, cancel, runResult)
			_ = awaitManagedHealthIdentity(t, cfg)
			initial := strings.ReplaceAll(fixture.request, "use the tool", "PRIVATE_USER_TEXT")
			denial := strings.ReplaceAll(fixture.continuation, `"content":"fixture-result"`, `"is_error":true,"content":"PRIVATE_TOOL_RESULT"`)
			denial = strings.ReplaceAll(denial, `"max_tokens":64`, `"max_tokens":64,"stream":true`)
			for i, payload := range []string{initial, denial, denial} {
				response := postJSON(t, cfg, fixture.path, payload)
				body := readResponse(t, response)
				_ = response.Body.Close()
				want := []string{"fixture_tool", "PRIVATE_ASSISTANT_TEXT", "end_turn"}[i]
				if response.StatusCode != http.StatusOK || !strings.Contains(body, want) || !strings.Contains(body, "message_stop") {
					t.Fatalf("step %d did not deliver its Anthropic continuation", i+1)
				}
			}

			data, err := os.ReadFile(filepath.Join(cfg.RuntimeDir, "managed-wire-projection.jsonl"))
			if mode.options == "{}" {
				if !os.IsNotExist(err) {
					t.Fatal("projection emitted on the default instance")
				}
				return
			}
			if err != nil {
				t.Fatal("enabled instance did not write a projection")
			}
			output := string(data)
			for _, forbidden := range []string{"PRIVATE_", "fixture fixture", cfg.DownstreamBearer} {
				if strings.Contains(output, forbidden) {
					t.Fatal("wire log disclosed non-structural fixture data")
				}
			}
			var records []wireFixtureRecord
			for _, line := range strings.Split(strings.TrimSpace(output), "\n") {
				var record wireFixtureRecord
				if err := json.Unmarshal([]byte(line), &record); err != nil {
					t.Fatal("wire record was not JSON")
				}
				records = append(records, record)
			}
			if len(records) != 3 {
				t.Fatalf("projection recorded %d requests, want tool request and both continuation cases", len(records))
			}
			for _, record := range records {
				if record.Method != "POST" || record.Path != "/v1/messages" || record.Model != fixture.model ||
					len(record.Upstream) != 1 || record.Upstream[0].Status != http.StatusOK {
					t.Fatal("projection omitted request metadata or upstream status")
				}
			}
			first := records[0].Downstream
			if first.StopReason != "tool_use" || !containsWireFixtureBlock(first, wireFixtureBlock{Type: "tool_use", ID: "call_1", Name: "fixture_tool"}) {
				t.Fatalf("projection lost the tool-use block or stop reason: %+v", first)
			}
			second := records[1]
			if !reflect.DeepEqual(second.Upstream[0].EventTypes, []string{"response.created", "response.completed"}) ||
				!containsWireFixtureBlock(second.Upstream[0], wireFixtureBlock{Type: "output_text", TextLength: len("PRIVATE_ASSISTANT_TEXT")}) {
				t.Fatal("projection lost ordered raw events or terminal-only text length")
			}
			if second.Downstream.StopReason != "end_turn" || !containsWireFixtureBlock(second.Downstream, wireFixtureBlock{Type: "text", TextLength: len("PRIVATE_ASSISTANT_TEXT")}) ||
				!reflect.DeepEqual(second.Downstream.EventTypes, []string{"message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"}) {
				t.Fatal("projection lost ordered translated events, text length or end_turn")
			}
			empty := records[2]
			if !reflect.DeepEqual(empty.Upstream[0].EventTypes, []string{"response.created", "unknown", "response.completed"}) ||
				len(empty.Upstream[0].Blocks) != 0 || len(empty.Downstream.Blocks) != 0 || empty.Downstream.StopReason != "end_turn" {
				t.Fatal("projection did not distinguish a genuinely empty upstream completion")
			}
			t.Log("terminal-only continuation reached Anthropic; empty upstream completion remained empty")
		})
	}
}

type wireFixtureRecord struct {
	Method, Path, Model string
	Upstream            []wireFixtureStream
	Downstream          wireFixtureStream
}

type wireFixtureStream struct {
	Status     int
	EventTypes []string
	StopReason string
	Blocks     []wireFixtureBlock
}

type wireFixtureBlock struct {
	Type, ID, Name string
	TextLength     int
}

func containsWireFixtureBlock(stream wireFixtureStream, want wireFixtureBlock) bool {
	for _, block := range stream.Blocks {
		if block == want {
			return true
		}
	}
	return false
}

// The managed gateway runs its real Meta executor and Anthropic codec.
// This replaces only the vendor HTTP effect and its response.
type deniedToolWireFixture struct {
	requests int
}

func (f *deniedToolWireFixture) RoundTrip(request *http.Request) (*http.Response, error) {
	defer request.Body.Close()
	body, err := io.ReadAll(request.Body)
	if err != nil {
		return nil, err
	}
	f.requests++
	var stream string
	switch f.requests {
	case 1:
		stream = strings.ReplaceAll(crossProtocolToolStream(false), `\"ok\"`, `\"PRIVATE_TOOL_INPUT\"`)
		stream = strings.ReplaceAll(stream, "gpt-6.1-sol", "muse-spark-1.3")
	case 2, 3:
		var payload struct {
			Input []struct {
				Type, Output string
				CallID       string `json:"call_id"`
			}
		}
		if err := json.Unmarshal(body, &payload); err != nil {
			return nil, err
		}
		found := false
		for _, item := range payload.Input {
			found = found || (item.Type == "function_call_output" && item.CallID == "call_1" && item.Output == "PRIVATE_TOOL_RESULT")
		}
		if !found {
			return nil, fmt.Errorf("translated denied result lost its output or call ID")
		}
		stream = "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_denied\",\"model\":\"muse-spark-1.3\",\"output\":[]}}\n\n" +
			`data: {"type":"response.completed","response":{"id":"resp_denied","model":"muse-spark-1.3","status":"completed","output":[{"type":"message","id":"msg_denied","role":"assistant","status":"completed","content":[{"type":"output_text","text":"PRIVATE_ASSISTANT_TEXT"}]}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}` + "\n\n"
		if f.requests == 3 {
			stream = strings.Replace(stream, `data: {"type":"response.completed"`, "data: {\"type\":\"PRIVATE_UNKNOWN_EVENT\"}\n\ndata: {\"type\":\"response.completed\"", 1)
			stream = strings.Replace(stream, `[{"type":"message","id":"msg_denied","role":"assistant","status":"completed","content":[{"type":"output_text","text":"PRIVATE_ASSISTANT_TEXT"}]}]`, "[]", 1)
		}
	default:
		return nil, fmt.Errorf("unexpected replay of denied-tool request")
	}
	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": {"text/event-stream"}, "X-Fixture": {"PRIVATE_HEADER"}},
		Body:       io.NopCloser(strings.NewReader(stream)),
		Request:    request,
	}, nil
}
