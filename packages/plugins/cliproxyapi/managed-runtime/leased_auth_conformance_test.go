package managedruntime

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

func TestLeasedClaudeDoesNotFetchSentinelProfile(t *testing.T) {
	var profileCalls atomic.Int32
	// The OAuth profile client uses a separate HTTP transport. Trap that OS/network
	// boundary through the registered auth's proxy; inference uses the fixture below.
	profileProxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		profileCalls.Add(1)
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer profileProxy.Close()
	testCase := crossProtocolCases()[1]
	cfg := crossProtocolConfig(t, testCase)
	broker := &sequenceBroker{leases: []RequestAuthHeaders{validLease("current-claude-lease", nil)}}
	upstream := &protocolFixtureRoundTripper{}
	gateway, err := NewGateway(cfg, testRuntimeIdentity(), broker, upstream)
	if err != nil {
		t.Fatal(err)
	}
	cancel, result := runGateway(t, gateway)
	defer stopGateway(t, cancel, result)
	_ = awaitManagedHealthIdentity(t, cfg)
	executor, ok := gateway.coreManager.Executor("claude")
	if !ok {
		t.Fatal("Claude executor is missing")
	}
	preparer, ok := executor.(coreauth.RequestAuthPreparer)
	if !ok {
		t.Fatal("pinned Claude auth preparation contract changed")
	}
	probe := managedRuntimeAuth(cfg.AuthEntries[0])
	probe.ProxyURL = profileProxy.URL
	if _, err := preparer.PrepareRequestAuth(context.Background(), probe); err != nil {
		t.Fatalf("leased Claude auth preparation failed: %v", err)
	}
	response := postJSON(t, cfg, testCase.path, testCase.continuation)
	body := readResponse(t, response)
	if profileCalls.Load() != 0 || response.StatusCode != http.StatusOK {
		t.Fatalf("leased Claude sent %d sentinel profile calls, status=%d body=%s", profileCalls.Load(), response.StatusCode, body)
	}
	requests := upstream.requests()
	if len(requests) != 1 || requests[0].Header.Get("Authorization") != "Bearer current-claude-lease" || len(broker.purposes()) != 1 {
		t.Fatal("Claude inference did not use exactly one current lease")
	}
}

func TestLeasedGatewayAcceptsRotatedLeaseAfterUnauthorized(t *testing.T) {
	for _, stream := range []bool{false, true} {
		t.Run(fmt.Sprintf("stream=%t", stream), func(t *testing.T) {
			testCase := crossProtocolCases()[0]
			testCase.model = "gpt-6.1-sol"
			testCase.request = fmt.Sprintf(`{"model":"gpt-6.1-sol","stream":%t,"max_tokens":64,"messages":[{"role":"user","content":"hello"}]}`, stream)
			cfg := crossProtocolConfig(t, testCase)
			broker := &sequenceBroker{leases: []RequestAuthHeaders{
				validLease("rejected-lease", nil), validLease("rotated-lease", nil),
			}}
			upstream := &protocolFixtureRoundTripper{statuses: []int{http.StatusUnauthorized, http.StatusOK}}
			gateway, err := NewGateway(cfg, testRuntimeIdentity(), broker, upstream)
			if err != nil {
				t.Fatal(err)
			}
			cancel, result := runGateway(t, gateway)
			defer stopGateway(t, cancel, result)
			_ = awaitManagedHealthIdentity(t, cfg)
			for i, status := range []int{http.StatusUnauthorized, http.StatusOK} {
				response := postJSON(t, cfg, testCase.path, testCase.request)
				body := readResponse(t, response)
				if response.StatusCode != status {
					t.Fatalf("request %d status=%d body=%s; want %d", i, response.StatusCode, body, status)
				}
			}
			requests := upstream.requests()
			if len(requests) != 2 || requests[1].Header.Get("Authorization") != "Bearer rotated-lease" || len(broker.authFailures) != 1 || len(broker.purposes()) != 2 {
				t.Fatal("401 poisoned the SDK entry or caused a hidden replay")
			}
		})
	}
}

func TestLeasedGatewayDoesNotCreateKVFiles(t *testing.T) {
	testCase := crossProtocolCases()[0]
	cfg := crossProtocolConfig(t, testCase)
	gateway, err := NewGateway(cfg, testRuntimeIdentity(), &sequenceBroker{}, &protocolFixtureRoundTripper{})
	if err != nil {
		t.Fatal(err)
	}
	cancel, result := runGateway(t, gateway)
	defer stopGateway(t, cancel, result)
	_ = awaitManagedHealthIdentity(t, cfg)
	assertNoRuntimeStateFiles(t, cfg.RuntimeDir)
}
