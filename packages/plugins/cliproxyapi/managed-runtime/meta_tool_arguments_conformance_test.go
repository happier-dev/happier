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

func TestManagedMetaResponsesNormalizesNativeToolArguments(t *testing.T) {
	for _, fixture := range []struct {
		name, arguments, want string
		terminalOnly          bool
		nonStreaming          bool
		numbers               []projectedNumber
	}{
		{"normalized with projection off", `{"session_id":44069,"yield_time_ms":30000.0}`, `{"session_id":44069,"yield_time_ms":30000}`, false, false, nil},
		{"fragmented mixed spellings", `{"session_id":44069.0, "yield_time_ms":30000.0,"max_output_tokens":30000.5,"number":30000.0,"nested":{"yield_time_ms":30000.0},"text":"PRIVATE_STRING_ARGUMENT","numeric_string":"123456","empty":null}`,
			`{"session_id":44069, "yield_time_ms":30000,"max_output_tokens":30000.5,"number":30000.0,"nested":{"yield_time_ms":30000.0},"text":"PRIVATE_STRING_ARGUMENT","numeric_string":"123456","empty":null}`, false, false,
			[]projectedNumber{{"/max_output_tokens", "decimal-with-fraction"}, {"/nested/yield_time_ms", "decimal-with-fraction"}, {"/number", "decimal-with-fraction"}, {"/session_id", "decimal-with-fraction"}, {"/yield_time_ms", "decimal-with-fraction"}}},
		{"nested numbers in terminal response", `{"session_id":44069,"yield_time_ms":30000,"nested":[true,{"a/b~c":-1.25e2},5e-2]}`, "", true, false,
			[]projectedNumber{{"/nested/1/a~1b~0c", "decimal-with-fraction"}, {"/nested/2", "exponent"}, {"/session_id", "integer"}, {"/yield_time_ms", "integer"}}},
		{"non-streaming downstream response", `{"session_id":44069,"yield_time_ms":30000.0}`, `{"session_id":44069,"yield_time_ms":30000}`, true, true,
			[]projectedNumber{{"/session_id", "integer"}, {"/yield_time_ms", "decimal-with-fraction"}}},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			cfg := crossProtocolConfig(t, metaProtocolCases()[1])
			cfg.WireProjection = fixture.numbers != nil
			broker := &sequenceBroker{leases: []RequestAuthHeaders{validLease("meta-fixture", map[string]string{"x-api-version": "1.0.0"})}}
			upstream := wireTransport(func(request *http.Request) (*http.Response, error) {
				if request.URL.Host != "api.meta.ai" || request.URL.Path != "/v1/responses" {
					return nil, fmt.Errorf("Meta fixture received a request outside its native Responses route")
				}
				defer request.Body.Close()
				var body struct {
					Tools []struct {
						Name       string
						Parameters struct {
							Properties map[string]struct{ Type string }
						}
					}
				}
				if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
					return nil, fmt.Errorf("Meta fixture received an invalid request")
				}
				for _, tool := range body.Tools {
					if tool.Name == "write_stdin" && tool.Parameters.Properties["session_id"].Type == "integer" && tool.Parameters.Properties["yield_time_ms"].Type == "integer" &&
						tool.Parameters.Properties["max_output_tokens"].Type == "integer" &&
						tool.Parameters.Properties["number"].Type == "number" {
						return metaToolArgumentsFixtureResponse(request, fixture.arguments, fixture.terminalOnly), nil
					}
				}
				return nil, fmt.Errorf("Meta fixture did not receive the native tool's integer parameter schema")
			})
			gateway, err := NewGateway(cfg, testRuntimeIdentity(), broker, upstream)
			if err != nil {
				t.Fatal(err)
			}
			cancel, result := runGateway(t, gateway)
			defer stopGateway(t, cancel, result)
			_ = awaitManagedHealthIdentity(t, cfg)

			body := strings.NewReader(fmt.Sprintf(`{"model":"muse-spark-1.3","stream":%t,"input":"poll the command","tools":[{"type":"function","name":"write_stdin","parameters":{"type":"object","properties":{"session_id":{"type":"number"},"yield_time_ms":{"type":"number"},"max_output_tokens":{"type":"number"},"number":{"type":"number"}}}}]}`, !fixture.nonStreaming))
			request, err := http.NewRequest(http.MethodPost, fmt.Sprintf("http://%s:%d/v1/responses", cfg.Host, cfg.Port), body)
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Authorization", "Bearer "+cfg.DownstreamBearer)
			request.Header.Set("User-Agent", "codex_cli_rs/0.162.1")
			response, err := http.DefaultClient.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			if response.StatusCode != http.StatusOK {
				t.Fatalf("native Responses stream status = %d", response.StatusCode)
			}
			payload := readResponse(t, response)
			want := fixture.want
			if want == "" {
				want = fixture.arguments
			}
			if fixture.nonStreaming {
				var completed struct{ Output []struct{ Arguments string } }
				if json.Unmarshal([]byte(payload), &completed) != nil || len(completed.Output) != 1 || completed.Output[0].Arguments != want {
					t.Fatal("arguments changed in the non-streaming Responses body")
				}
			} else {
				assertNativeToolArguments(t, payload, want, fixture.terminalOnly)
			}
			downstreamNumbers := append([]projectedNumber(nil), fixture.numbers...)
			for i := range downstreamNumbers {
				number := &downstreamNumbers[i]
				if (number.Path == "/session_id" || number.Path == "/yield_time_ms") && fixture.want != "" {
					number.Class = "integer"
				}
			}
			assertResponsesNumberProjection(t, cfg, fixture.numbers, downstreamNumbers, fixture.terminalOnly, fixture.nonStreaming)
		})
	}
}

type projectedNumber struct{ Path, Class string }

func assertResponsesNumberProjection(t *testing.T, cfg Config, numbers, downstreamNumbers []projectedNumber, terminalOnly, nonStreaming bool) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(cfg.RuntimeDir, wireProjectionFile))
	if numbers == nil {
		if !os.IsNotExist(err) {
			t.Fatal("projection emitted on the default Responses instance")
		}
		return
	}
	if err != nil {
		t.Fatal("enabled Responses request did not write a projection")
	}
	for _, forbidden := range []string{"PRIVATE_STRING_ARGUMENT", "123456", "44069", "30000", "poll the command", "meta-fixture", cfg.DownstreamBearer} {
		if strings.Contains(string(data), forbidden) {
			t.Fatal("Responses projection disclosed a value or credential")
		}
	}
	type observation struct {
		Event       string
		OutputIndex int
		Numbers     []projectedNumber
	}
	type stream struct {
		ArgumentNumbers []observation
		Incomplete      bool
	}
	var record struct {
		Method, Path string
		Upstream     []stream
		Downstream   stream
	}
	if json.Unmarshal(data, &record) != nil || record.Method != http.MethodPost || record.Path != "/v1/responses" || len(record.Upstream) != 1 {
		t.Fatal("missing a Responses record with an upstream attempt and downstream response")
	}
	want := []observation{{"response.completed", 0, numbers}}
	if !terminalOnly {
		want = append([]observation{
			{"response.function_call_arguments.delta", 0, numbers},
			{"response.function_call_arguments.done", 0, numbers},
			{"response.output_item.done", 0, numbers},
		}, want...)
	}
	egress := make([]observation, 0, len(want))
	for _, event := range want {
		egress = append(egress, observation{event.Event, event.OutputIndex, downstreamNumbers})
	}
	if nonStreaming {
		egress = []observation{{"response", 0, downstreamNumbers}}
	}
	for _, side := range []struct {
		name string
		got  stream
		want []observation
	}{
		{"ingress", record.Upstream[0], want},
		{"egress", record.Downstream, egress},
	} {
		if side.got.Incomplete || !reflect.DeepEqual(side.got.ArgumentNumbers, side.want) {
			t.Errorf("%s number spelling projection = %+v, want %v", side.name, side.got, side.want)
		}
	}
}

func metaToolArgumentsFixtureResponse(request *http.Request, arguments string, terminalOnly bool) *http.Response {
	item := fmt.Sprintf(`{"id":"fc_1","type":"function_call","call_id":"call_1","name":"write_stdin","status":"completed","arguments":%q}`, arguments)
	var stream strings.Builder
	if !terminalOnly {
		stream.WriteString("data: " + `{"type":"response.output_item.added","output_index":0,"item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"write_stdin","arguments":"","status":"in_progress"}}` + "\n\n")
		first, second, _ := strings.Cut(arguments, "30")
		for _, delta := range []string{first + "30", second} {
			fmt.Fprintf(&stream, "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc_1\",\"output_index\":0,\"delta\":%q}\n\n", delta)
		}
		fmt.Fprintf(&stream, "data: {\"type\":\"response.function_call_arguments.done\",\"item_id\":\"fc_1\",\"output_index\":0,\"arguments\":%q}\n\n", arguments)
		fmt.Fprintf(&stream, "data: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":%s}\n\n", item)
	}
	fmt.Fprintf(&stream, "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"model\":\"muse-spark-1.3\",\"status\":\"completed\",\"output\":[%s]}}\n\n", item)
	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": {"text/event-stream"}},
		Body:       io.NopCloser(strings.NewReader(stream.String())),
		Request:    request,
	}
}

func assertNativeToolArguments(t *testing.T, body, want string, terminalOnly bool) {
	t.Helper()
	type toolCall struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	}
	var deltas strings.Builder
	var sawDone, sawItem, sawCompleted bool
	for _, line := range strings.Split(body, "\n") {
		data, ok := strings.CutPrefix(line, "data:")
		if !ok {
			continue
		}
		var event struct {
			Type      string `json:"type"`
			Delta     string `json:"delta"`
			Arguments string `json:"arguments"`
			Item      toolCall
			Response  struct{ Output []toolCall }
		}
		if err := json.Unmarshal([]byte(data), &event); err != nil {
			t.Fatal("invalid Responses SSE JSON")
		}
		switch event.Type {
		case "response.function_call_arguments.delta":
			deltas.WriteString(event.Delta)
		case "response.function_call_arguments.done":
			sawDone = true
			if event.Arguments != want {
				t.Fatal("arguments changed in the function_call_arguments.done event")
			}
		case "response.output_item.done":
			sawItem = true
			if event.Item.Name != "write_stdin" || event.Item.Arguments != want {
				t.Fatal("tool name or arguments changed in the output_item.done event")
			}
		case "response.completed":
			sawCompleted = true
			if len(event.Response.Output) != 1 || event.Response.Output[0].Name != "write_stdin" || event.Response.Output[0].Arguments != want {
				t.Fatal("tool name or arguments changed in the completed response")
			}
		}
	}
	if !sawCompleted || (!terminalOnly && (!sawDone || !sawItem || deltas.String() != want)) {
		t.Fatalf("expected matching argument deltas, arguments.done, output_item.done and response.completed (done=%t item=%t completed=%t)", sawDone, sawItem, sawCompleted)
	}
}
