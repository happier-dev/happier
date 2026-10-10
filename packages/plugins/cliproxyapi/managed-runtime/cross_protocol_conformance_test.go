package managedruntime

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// Exact v7.2.95 / f71ec0eb carrier evidence. Only the upstream HTTP transport
// and request-auth broker are faked; routing, executors and codecs stay real.
type crossProtocolCase struct {
	name, path, model, purpose, host, terminal, toolKind string
	provider                                             Provider
	protocol                                             ProviderProtocol
	request, continuation                                string
}

func crossProtocolCases() []crossProtocolCase {
	return []crossProtocolCase{
		{
			name: "Messages to Codex", provider: ProviderCodex, protocol: ProtocolAnthropic,
			path: "/v1/messages", model: "gpt-5.5", purpose: "openai-upstream", host: "chatgpt.com",
			terminal: `"type":"message_stop"`, toolKind: `"type":"tool_use"`,
			request:      `{"model":"gpt-5.5","max_tokens":64,"stream":true,"messages":[{"role":"user","content":"use the tool"}],"tools":[{"name":"fixture_tool","description":"fixture","input_schema":{"type":"object","properties":{"value":{"type":"string"}}}}]}`,
			continuation: `{"model":"gpt-5.5","max_tokens":64,"messages":[{"role":"user","content":"use the tool"},{"role":"assistant","content":[{"type":"tool_use","id":"call_1","name":"fixture_tool","input":{"value":"ok"}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_1","content":"fixture-result"}]}]}`,
		},
		{
			name: "Responses to Claude", provider: ProviderClaude, protocol: ProtocolOpenAIResponses,
			path: "/v1/responses", model: "claude-sonnet-4-6", purpose: "anthropic-upstream", host: "api.anthropic.com",
			terminal: `"type":"response.completed"`, toolKind: `"type":"function_call"`,
			request:      `{"model":"claude-sonnet-4-6","stream":true,"input":"use the tool","tools":[{"type":"function","name":"fixture_tool","description":"fixture","parameters":{"type":"object","properties":{"value":{"type":"string"}}}}]}`,
			continuation: `{"model":"claude-sonnet-4-6","input":[{"type":"message","role":"user","content":"use the tool"},{"type":"function_call","call_id":"call_1","name":"fixture_tool","arguments":"{\"value\":\"ok\"}"},{"type":"function_call_output","call_id":"call_1","output":"fixture-result"}]}`,
		},
		{
			name: "Chat to Claude", provider: ProviderClaude, protocol: ProtocolOpenAIChat,
			path: "/v1/chat/completions", model: "claude-sonnet-4-6", purpose: "anthropic-upstream", host: "api.anthropic.com",
			terminal: "[DONE]", toolKind: `"tool_calls"`,
			request:      `{"model":"claude-sonnet-4-6","stream":true,"messages":[{"role":"user","content":"use the tool"}],"tools":[{"type":"function","function":{"name":"fixture_tool","description":"fixture","parameters":{"type":"object","properties":{"value":{"type":"string"}}}}}]}`,
			continuation: `{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"use the tool"},{"role":"assistant","tool_calls":[{"id":"call_1","type":"function","function":{"name":"fixture_tool","arguments":"{\"value\":\"ok\"}"}}]},{"role":"tool","tool_call_id":"call_1","content":"fixture-result"}]}`,
		},
	}
}

func crossProtocolConfig(t *testing.T, testCase crossProtocolCase) Config {
	t.Helper()
	id := "codex"
	if testCase.provider == ProviderClaude {
		id = "claude"
	}
	return Config{
		Host: "127.0.0.1", Port: reserveLoopbackPort(t), DownstreamBearer: "downstream-session-bearer", RuntimeDir: t.TempDir(),
		AuthEntries: []AuthEntry{testAuthEntry(id, testCase.provider, testCase.purpose)},
		Protocols:   []ProviderProtocol{testCase.protocol}, ModelListEnabled: true,
	}
}

func TestPinnedSDKCrossProtocolStreamingToolRoundTrip(t *testing.T) {
	for _, testCase := range crossProtocolCases() {
		t.Run(testCase.name, func(t *testing.T) {
			cfg := crossProtocolConfig(t, testCase)
			broker := &sequenceBroker{leases: []OAuthBearerLease{validLease("current-one", nil), validLease("current-two", nil)}}
			upstream := &protocolFixtureRoundTripper{toolCall: true}
			gateway, err := NewGateway(cfg, testRuntimeIdentity(), broker, upstream)
			if err != nil {
				t.Fatal(err)
			}
			cancel, runResult := runGateway(t, gateway)
			defer stopGateway(t, cancel, runResult)
			_ = awaitManagedHealthIdentity(t, cfg)
			for _, model := range gateway.Catalog() {
				if model.Provider != testCase.provider {
					t.Fatalf("catalog advertised unbound family: %#v", model)
				}
			}
			response := postJSON(t, cfg, testCase.path, testCase.request)
			body := readResponse(t, response)
			_ = response.Body.Close()
			if response.StatusCode != http.StatusOK {
				t.Fatalf("stream status %d: %s", response.StatusCode, body)
			}
			for _, fragment := range []string{testCase.terminal, testCase.toolKind, "fixture_tool", "call_1", "ok"} {
				if !strings.Contains(body, fragment) {
					t.Fatalf("translated stream omitted %q: %s", fragment, body)
				}
			}
			response = postJSON(t, cfg, testCase.path, testCase.continuation)
			body = readResponse(t, response)
			_ = response.Body.Close()
			if response.StatusCode != http.StatusOK {
				t.Fatalf("continuation status %d: %s", response.StatusCode, body)
			}
			requests := upstream.requests()
			if len(requests) != 2 {
				t.Fatalf("upstream attempts = %d, want 2", len(requests))
			}
			for i, request := range requests {
				if request.URL.Host != testCase.host || request.Header.Get("Authorization") != []string{"Bearer current-one", "Bearer current-two"}[i] {
					t.Fatalf("wrong upstream/current credential: %s, %s", request.URL, request.Header.Get("Authorization"))
				}
				payload, err := io.ReadAll(request.Body)
				if err != nil {
					t.Fatal(err)
				}
				if i == 0 && !strings.Contains(string(payload), `"name":"fixture_tool"`) {
					t.Fatalf("upstream lost tool declaration: %s", payload)
				}
				if i == 1 && (!strings.Contains(string(payload), "fixture-result") || !strings.Contains(string(payload), "call_1")) {
					t.Fatalf("upstream lost tool result correlation: %s", payload)
				}
			}
			purposes := broker.purposes()
			if len(purposes) != 2 || purposes[0] != testPurpose(testCase.purpose) || purposes[1] != testPurpose(testCase.purpose) {
				t.Fatalf("request-auth used unbound family: %#v", purposes)
			}
			assertNoRuntimeStateFiles(t, cfg.RuntimeDir)
		})
	}
}

func TestPinnedSDKCrossProtocolErrorsHaveNoHiddenReplay(t *testing.T) {
	for _, testCase := range crossProtocolCases() {
		t.Run(testCase.name, func(t *testing.T) {
			cfg := crossProtocolConfig(t, testCase)
			broker := &sequenceBroker{leases: []OAuthBearerLease{validLease("error-member", nil), validLease("error-member", nil), validLease("error-member", nil), validLease("error-member", nil)}}
			upstream := &protocolFixtureRoundTripper{statuses: []int{401, 403, 429, 500}}
			gateway, err := NewGateway(cfg, testRuntimeIdentity(), broker, upstream)
			if err != nil {
				t.Fatal(err)
			}
			cancel, runResult := runGateway(t, gateway)
			defer stopGateway(t, cancel, runResult)
			_ = awaitManagedHealthIdentity(t, cfg)
			for _, status := range upstream.statuses {
				response := postJSON(t, cfg, testCase.path, testCase.request)
				body := readResponse(t, response)
				_ = response.Body.Close()
				if response.StatusCode != status || !strings.Contains(body, "fixture failure") {
					t.Fatalf("translated error = %d / %s, want %d", response.StatusCode, body, status)
				}
			}
			if len(upstream.requests()) != 4 || len(broker.purposes()) != 4 {
				t.Fatalf("hidden retry or cooldown: %d upstream / %d lookups", len(upstream.requests()), len(broker.purposes()))
			}
		})
	}
}

func TestPinnedSDKCrossProtocolCancellation(t *testing.T) {
	for _, testCase := range crossProtocolCases() {
		t.Run(testCase.name, func(t *testing.T) {
			cfg := crossProtocolConfig(t, testCase)
			broker := &sequenceBroker{leases: []OAuthBearerLease{validLease("cancel-member", nil)}}
			upstream := &cancellationRoundTripper{started: make(chan struct{}), canceled: make(chan struct{})}
			gateway, err := NewGateway(cfg, testRuntimeIdentity(), broker, upstream)
			if err != nil {
				t.Fatal(err)
			}
			cancel, runResult := runGateway(t, gateway)
			defer stopGateway(t, cancel, runResult)
			_ = awaitManagedHealthIdentity(t, cfg)
			ctx, cancelRequest := context.WithCancel(context.Background())
			defer cancelRequest()
			request, err := http.NewRequestWithContext(ctx, http.MethodPost, fmt.Sprintf("http://%s:%d%s", cfg.Host, cfg.Port, testCase.path), strings.NewReader(testCase.request))
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set("Authorization", "Bearer "+cfg.DownstreamBearer)
			request.Header.Set("Content-Type", "application/json")
			result := make(chan error, 1)
			go func() {
				response, err := http.DefaultClient.Do(request)
				if response != nil {
					_ = response.Body.Close()
				}
				result <- err
			}()
			select {
			case <-upstream.started:
			case <-time.After(5 * time.Second):
				t.Fatal("translated upstream did not start")
			}
			cancelRequest()
			select {
			case <-upstream.canceled:
			case <-time.After(5 * time.Second):
				t.Fatal("translated upstream was not canceled")
			}
			select {
			case err := <-result:
				if err == nil {
					t.Fatal("canceled request succeeded")
				}
			case <-time.After(5 * time.Second):
				t.Fatal("canceled client did not settle")
			}
			if purposes := broker.purposes(); len(purposes) != 1 || purposes[0] != testPurpose(testCase.purpose) {
				t.Fatalf("cancellation used another account: %#v", purposes)
			}
		})
	}
}

func TestPinnedSDKCrossProtocolAuxiliarySurfaces(t *testing.T) {
	for _, testCase := range crossProtocolCases()[:2] {
		t.Run(testCase.name, func(t *testing.T) {
			cfg := crossProtocolConfig(t, testCase)
			broker := &sequenceBroker{leases: []OAuthBearerLease{validLease("auxiliary-member", nil)}}
			upstream := &protocolFixtureRoundTripper{}
			gateway, err := NewGateway(cfg, testRuntimeIdentity(), broker, upstream)
			if err != nil {
				t.Fatal(err)
			}
			cancel, runResult := runGateway(t, gateway)
			defer stopGateway(t, cancel, runResult)
			_ = awaitManagedHealthIdentity(t, cfg)
			if testCase.protocol == ProtocolAnthropic {
				response := postJSON(t, cfg, "/v1/messages/count_tokens", testCase.continuation)
				body := readResponse(t, response)
				_ = response.Body.Close()
				if response.StatusCode != http.StatusOK || !strings.Contains(body, `"input_tokens":`) {
					t.Fatalf("translated count tokens = %d: %s", response.StatusCode, body)
				}
				if len(broker.purposes()) != 0 || len(upstream.requests()) != 0 {
					t.Fatal("local Codex token counting performed an upstream effect")
				}
				return
			}
			connection, _, err := websocket.DefaultDialer.Dial(fmt.Sprintf("ws://%s:%d/v1/responses", cfg.Host, cfg.Port), http.Header{"Authorization": {"Bearer " + cfg.DownstreamBearer}})
			if err != nil {
				t.Fatal(err)
			}
			defer connection.Close()
			_ = connection.SetReadDeadline(time.Now().Add(5 * time.Second))
			if err := connection.WriteMessage(websocket.TextMessage, []byte(`{"type":"response.create","model":"claude-sonnet-4-6","input":"hello"}`)); err != nil {
				t.Fatal(err)
			}
			for {
				_, payload, err := connection.ReadMessage()
				if err != nil {
					t.Fatal(err)
				}
				if strings.Contains(string(payload), `"type":"response.completed"`) {
					break
				}
			}
			if purposes := broker.purposes(); len(purposes) != 1 || purposes[0] != testPurpose(testCase.purpose) {
				t.Fatalf("websocket selected another account: %#v", purposes)
			}
			if requests := upstream.requests(); len(requests) != 1 || requests[0].URL.Host != testCase.host {
				t.Fatalf("websocket upstream: %#v", requests)
			}
		})
	}
}

// Build the real source protocol events, including argument deltas and the
// terminal item. This fixture represents only a genuine remote response.
func crossProtocolToolStream(claude bool) string {
	if claude {
		return "event: message_start\ndata: " + `{"type":"message_start","message":{"id":"msg_tools","type":"message","role":"assistant","model":"claude-sonnet-4-6","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}` + "\n\n" +
			"event: content_block_start\ndata: " + `{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_1","name":"fixture_tool","input":{}}}` + "\n\n" +
			"event: content_block_delta\ndata: " + `{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"value\":\"ok\"}"}}` + "\n\n" +
			"event: content_block_stop\ndata: " + `{"type":"content_block_stop","index":0}` + "\n\n" +
			"event: message_delta\ndata: " + `{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":1}}` + "\n\n" +
			"event: message_stop\ndata: " + `{"type":"message_stop"}` + "\n\n"
	}
	item := json.RawMessage(`{"id":"fc_1","type":"function_call","call_id":"call_1","name":"fixture_tool","arguments":"{\"value\":\"ok\"}","status":"completed"}`)
	var stream strings.Builder
	for _, event := range []map[string]any{
		{"type": "response.created", "response": map[string]any{"id": "resp_tools", "model": "gpt-5.5", "status": "in_progress", "output": []any{}}},
		{"type": "response.output_item.added", "output_index": 0, "item": json.RawMessage(`{"id":"fc_1","type":"function_call","call_id":"call_1","name":"fixture_tool","arguments":"","status":"in_progress"}`)},
		{"type": "response.function_call_arguments.delta", "item_id": "fc_1", "output_index": 0, "delta": `{"value":"ok"}`},
		{"type": "response.function_call_arguments.done", "item_id": "fc_1", "output_index": 0, "arguments": `{"value":"ok"}`},
		{"type": "response.output_item.done", "output_index": 0, "item": item},
		{"type": "response.completed", "response": map[string]any{"id": "resp_tools", "model": "gpt-5.5", "status": "completed", "output": []any{item}, "usage": map[string]int{"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}}},
	} {
		encoded, _ := json.Marshal(event)
		stream.WriteString("data: " + string(encoded) + "\n\n")
	}
	return stream.String()
}
