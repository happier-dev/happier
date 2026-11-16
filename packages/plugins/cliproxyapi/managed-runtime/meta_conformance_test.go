package managedruntime

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

// Only the external Meta transport is replaced; the managed lease, SDK executor,
// selector and downstream Responses handler remain real.
type metaQuotaTransport struct {
	calls int
	body  string
}

func (t *metaQuotaTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	t.calls++
	return &http.Response{
		StatusCode: http.StatusTooManyRequests,
		Header:     http.Header{"Content-Type": {"application/json"}},
		Body:       io.NopCloser(strings.NewReader(t.body)),
		Request:    request,
	}, nil
}

func TestManagedMetaStreamingQuotaRefusalReachesResponsesClient(t *testing.T) {
	for _, refusal := range []struct{ name, message, code string }{
		{"hard quota", "Subscription quota exhausted", "insufficient_quota"},
		{"transient rate limit", "Too many requests", "rate_limit_exceeded"},
	} {
		t.Run(refusal.name, func(t *testing.T) {
			testCase := metaProtocolCases()[1]
			cfg := crossProtocolConfig(t, testCase)
			broker := &sequenceBroker{leases: []RequestAuthHeaders{validLease("meta-fixture-key", map[string]string{"x-api-version": "1.0.0"})}}
			// Field shape captured on nl3, 2026-11-15; message is the pinned
			// SDK's documented subscription fixture, never recorded by the observer.
			upstream := &metaQuotaTransport{body: `{"error":{"message":"` + refusal.message + `","type":"rate_limit_error","code":"rate_limit_exceeded","resets_at":1794787200}}`}
			gateway, err := NewGateway(cfg, testRuntimeIdentity(), broker, upstream)
			if err != nil {
				t.Fatal(err)
			}
			cancel, result := runGateway(t, gateway)
			defer stopGateway(t, cancel, result)
			_ = awaitManagedHealthIdentity(t, cfg)
			response := postJSON(t, cfg, testCase.path, testCase.request)
			defer response.Body.Close()
			body := readResponse(t, response)
			if response.StatusCode != http.StatusTooManyRequests || !strings.Contains(body, `"code":"`+refusal.code+`"`) || !strings.Contains(body, `"resets_at":1794787200`) {
				t.Fatalf("Meta quota refusal lost status, classification or reset: %d %s", response.StatusCode, body)
			}
			if upstream.calls != 1 {
				t.Fatalf("quota refusal replayed upstream: %d requests", upstream.calls)
			}
		})
	}
}

func metaProtocolCases() []crossProtocolCase {
	cases := crossProtocolCases()[:3]
	for index := range cases {
		old := cases[index].model
		cases[index].name = "Meta " + string(cases[index].protocol)
		cases[index].provider = ProviderMeta
		cases[index].purpose = "meta-upstream"
		cases[index].host = "api.meta.ai"
		cases[index].model = "muse-spark-1.3"
		cases[index].request = strings.ReplaceAll(cases[index].request, old, cases[index].model)
		cases[index].continuation = strings.ReplaceAll(cases[index].continuation, old, cases[index].model)
	}
	return cases
}

func TestManagedMetaRequiresResponsesWireForAllDownstreamProtocols(t *testing.T) {
	for _, testCase := range metaProtocolCases() {
		t.Run(testCase.name, func(t *testing.T) {
			cfg := crossProtocolConfig(t, testCase)
			material := validLease("meta-current-key", map[string]string{"x-api-version": "1.0.0"})
			broker := &sequenceBroker{leases: []RequestAuthHeaders{material, material}}
			upstream := &protocolFixtureRoundTripper{toolCall: true}
			gateway, err := NewGateway(cfg, testRuntimeIdentity(), broker, upstream)
			if err != nil {
				t.Fatal(err)
			}
			cancel, result := runGateway(t, gateway)
			defer stopGateway(t, cancel, result)
			_ = awaitManagedHealthIdentity(t, cfg)
			for index, input := range []string{testCase.request, testCase.continuation} {
				response := postJSON(t, cfg, testCase.path, input)
				body := readResponse(t, response)
				_ = response.Body.Close()
				if response.StatusCode != http.StatusOK || (index == 0 && (!strings.Contains(body, "fixture_tool") || !strings.Contains(body, "call_1"))) {
					t.Fatalf("Meta translated response = %d: %s", response.StatusCode, body)
				}
			}
			requests := upstream.requests()
			if len(requests) != 2 || len(broker.purposes()) != 2 {
				t.Fatalf("Meta must borrow once per actual attempt: %d requests / %d borrows", len(requests), len(broker.purposes()))
			}
			for index, request := range requests {
				payload, err := io.ReadAll(request.Body)
				if err != nil {
					t.Fatal(err)
				}
				if request.URL.Host != "api.meta.ai" || request.URL.Path != "/v1/responses" || request.Header.Get("Authorization") != "Bearer meta-current-key" || request.Header.Get("x-api-version") != "1.0.0" || !strings.Contains(string(payload), `"stream":true`) {
					t.Fatalf("Meta native Responses wire not used: URL=%s headers=%v body=%s", request.URL, request.Header, payload)
				}
				if index == 1 && (!strings.Contains(string(payload), "fixture-result") || !strings.Contains(string(payload), "call_1")) {
					t.Fatalf("Meta lost tool result correlation: %s", payload)
				}
			}
			assertNoRuntimeStateFiles(t, cfg.RuntimeDir)
		})
	}
}
