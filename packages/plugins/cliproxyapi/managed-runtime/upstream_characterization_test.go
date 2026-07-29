package managedruntime

import (
	"context"
	"net/http"
	"sync"
	"testing"
	"time"

	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/executor"
)

func TestPinnedSelectorBucketsAndManagedOneEntryInvariant(t *testing.T) {
	t.Parallel()

	authA := &coreauth.Auth{ID: "a", Provider: "fixture", Status: coreauth.StatusActive}
	authB := &coreauth.Auth{ID: "b", Provider: "fixture", Status: coreauth.StatusActive}
	roundRobin := &coreauth.RoundRobinSelector{}

	first, err := roundRobin.Pick(context.Background(), "fixture", "model(high)", cliproxyexecutor.Options{}, []*coreauth.Auth{authA, authB})
	if err != nil {
		t.Fatalf("first Pick() error = %v", err)
	}
	second, err := roundRobin.Pick(context.Background(), "fixture", "model", cliproxyexecutor.Options{}, []*coreauth.Auth{authA, authB})
	if err != nil {
		t.Fatalf("second Pick() error = %v", err)
	}
	if first.ID != "a" || second.ID != "b" {
		t.Fatalf("canonical model bucket round-robin = %s then %s, want a then b", first.ID, second.ID)
	}

	for i := 0; i < 3; i++ {
		selected, errPick := roundRobin.Pick(context.Background(), "fixture", "another-model", cliproxyexecutor.Options{}, []*coreauth.Auth{authA})
		if errPick != nil || selected.ID != "a" {
			t.Fatalf("one-entry Pick() %d = %#v, %v", i, selected, errPick)
		}
	}

	fillFirst := &coreauth.FillFirstSelector{}
	for i, model := range []string{"model(high)", "model"} {
		selected, errPick := fillFirst.Pick(
			context.Background(),
			"fixture",
			model,
			cliproxyexecutor.Options{},
			[]*coreauth.Auth{authB, authA},
		)
		if errPick != nil || selected.ID != "a" {
			t.Fatalf("fill-first Pick() %d = %#v, %v; want deterministic first eligible entry a", i, selected, errPick)
		}
	}
}

func TestPinnedSessionAffinityUsesProviderSessionAndRawModelBucket(t *testing.T) {
	t.Parallel()

	fallback := &recordingSelector{
		sequence: []*coreauth.Auth{
			{ID: "a", Provider: "fixture", Status: coreauth.StatusActive},
			{ID: "b", Provider: "fixture", Status: coreauth.StatusActive},
			{ID: "c", Provider: "other-fixture", Status: coreauth.StatusActive},
			{ID: "d", Provider: "other-fixture", Status: coreauth.StatusActive},
		},
	}
	selector := coreauth.NewSessionAffinitySelector(fallback)
	t.Cleanup(selector.Stop)
	auths := fallback.sequence
	opts := cliproxyexecutor.Options{Headers: http.Header{"X-Session-Id": {"session-1"}}}

	first, err := selector.Pick(context.Background(), "fixture", "model(high)", opts, auths)
	if err != nil {
		t.Fatalf("first affinity Pick() error = %v", err)
	}
	repeated, err := selector.Pick(context.Background(), "fixture", "model(high)", opts, auths)
	if err != nil {
		t.Fatalf("repeated affinity Pick() error = %v", err)
	}
	otherRawModel, err := selector.Pick(context.Background(), "fixture", "model", opts, auths)
	if err != nil {
		t.Fatalf("other-model affinity Pick() error = %v", err)
	}
	otherProvider, err := selector.Pick(context.Background(), "other-fixture", "model(high)", opts, auths)
	if err != nil {
		t.Fatalf("other-provider affinity Pick() error = %v", err)
	}
	if first.ID != "a" || repeated.ID != "a" || otherRawModel.ID != "b" || otherProvider.ID != "c" {
		t.Fatalf(
			"session-affinity picks = %s, %s, %s, %s; want a, a, b, c",
			first.ID,
			repeated.ID,
			otherRawModel.ID,
			otherProvider.ID,
		)
	}
	if fallback.calls != 3 {
		t.Fatalf("fallback calls = %d, want distinct raw-model and provider buckets", fallback.calls)
	}
}

func TestPinnedManagerRetryCooldownAndRefreshAreBehaviorallyInert(t *testing.T) {
	configurePinnedCooldownPolicy(t)

	executor := &recordingExecutor{
		executeErrors: []error{
			&coreauth.Error{HTTPStatus: http.StatusTooManyRequests, Message: "fixture quota"},
			nil,
		},
	}
	manager := coreauth.NewManager(nil, &coreauth.RoundRobinSelector{}, nil)
	manager.SetCooldownStateStore(nil)
	manager.SetRetryConfig(0, 0, 1)
	manager.RegisterExecutor(executor)
	auth := &coreauth.Auth{
		ID:       "logical-entry",
		Provider: executor.Identifier(),
		Status:   coreauth.StatusActive,
		Attributes: map[string]string{
			coreauth.AttributeAuthKind:    coreauth.AuthKindOAuth,
			coreauth.AttributeRuntimeOnly: "true",
		},
		Runtime: neverRefreshRuntime{},
	}
	if _, err := manager.Register(coreauth.WithSkipPersist(context.Background()), auth); err != nil {
		t.Fatalf("Register() error = %v", err)
	}

	_, firstErr := manager.Execute(context.Background(), []string{executor.Identifier()}, cliproxyexecutor.Request{}, cliproxyexecutor.Options{})
	if firstErr == nil {
		t.Fatal("first Execute() error = nil, want fixture quota")
	}
	if executor.executeCalls() != 1 {
		t.Fatalf("first Execute() calls = %d, want zero hidden retry", executor.executeCalls())
	}
	if _, secondErr := manager.Execute(context.Background(), []string{executor.Identifier()}, cliproxyexecutor.Request{}, cliproxyexecutor.Options{}); secondErr != nil {
		t.Fatalf("second independent Execute() remained cooled down: %v", secondErr)
	}
	if executor.executeCalls() != 2 {
		t.Fatalf("second Execute() total calls = %d, want 2", executor.executeCalls())
	}

	manager.StartAutoRefresh(context.Background(), 10*time.Millisecond)
	time.Sleep(80 * time.Millisecond)
	manager.StopAutoRefresh()
	if executor.refreshCalls() != 0 {
		t.Fatalf("auto-refresh executor calls = %d, want behaviorally inert runtime entry", executor.refreshCalls())
	}
}

func TestPinnedManagerStreamBootstrapReplayAndRefreshAreBehaviorallyInert(t *testing.T) {
	configurePinnedCooldownPolicy(t)

	executor := &recordingExecutor{
		streamErrors: []error{
			&coreauth.Error{HTTPStatus: http.StatusUnauthorized, Message: "fixture unauthorized bootstrap"},
			nil,
		},
	}
	manager := coreauth.NewManager(nil, &coreauth.RoundRobinSelector{}, nil)
	manager.SetCooldownStateStore(nil)
	manager.SetRetryConfig(0, 0, 1)
	manager.RegisterExecutor(executor)
	auth := &coreauth.Auth{
		ID:       "logical-entry",
		Provider: executor.Identifier(),
		Status:   coreauth.StatusActive,
		Attributes: map[string]string{
			coreauth.AttributeAuthKind:    coreauth.AuthKindOAuth,
			coreauth.AttributeRuntimeOnly: "true",
		},
		Runtime: neverRefreshRuntime{},
	}
	if _, err := manager.Register(coreauth.WithSkipPersist(context.Background()), auth); err != nil {
		t.Fatalf("Register() error = %v", err)
	}

	result, err := manager.ExecuteStream(
		context.Background(),
		[]string{executor.Identifier()},
		cliproxyexecutor.Request{},
		cliproxyexecutor.Options{},
	)
	if err != nil {
		t.Fatalf("ExecuteStream() error = %v", err)
	}
	if result == nil {
		t.Fatal("ExecuteStream() result = nil")
	}
	var bootstrapErr error
	for chunk := range result.Chunks {
		if chunk.Err != nil {
			bootstrapErr = chunk.Err
		}
	}
	if bootstrapErr == nil {
		t.Fatal("stream bootstrap error was not surfaced")
	}
	if executor.streamCalls() != 1 {
		t.Fatalf("ExecuteStream() calls = %d, want zero hidden bootstrap replay", executor.streamCalls())
	}
	if executor.refreshCalls() != 0 {
		t.Fatalf("bootstrap failure refresh calls = %d, want no native refresh effect", executor.refreshCalls())
	}
}

func configurePinnedCooldownPolicy(t *testing.T) {
	t.Helper()
	coreauth.SetQuotaCooldownDisabled(true)
	coreauth.SetTransientErrorCooldownSeconds(-1)
	t.Cleanup(func() {
		coreauth.SetQuotaCooldownDisabled(false)
		coreauth.SetTransientErrorCooldownSeconds(0)
	})
}

type recordingSelector struct {
	sequence []*coreauth.Auth
	calls    int
}

func (s *recordingSelector) Pick(context.Context, string, string, cliproxyexecutor.Options, []*coreauth.Auth) (*coreauth.Auth, error) {
	selected := s.sequence[s.calls%len(s.sequence)]
	s.calls++
	return selected, nil
}

type recordingExecutor struct {
	mu            sync.Mutex
	executeErrors []error
	streamErrors  []error
	executes      int
	streams       int
	refreshes     int
}

func (e *recordingExecutor) Identifier() string { return "fixture" }

func (e *recordingExecutor) Execute(context.Context, *coreauth.Auth, cliproxyexecutor.Request, cliproxyexecutor.Options) (cliproxyexecutor.Response, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	index := e.executes
	e.executes++
	if index < len(e.executeErrors) {
		return cliproxyexecutor.Response{}, e.executeErrors[index]
	}
	return cliproxyexecutor.Response{}, nil
}

func (e *recordingExecutor) ExecuteStream(context.Context, *coreauth.Auth, cliproxyexecutor.Request, cliproxyexecutor.Options) (*cliproxyexecutor.StreamResult, error) {
	e.mu.Lock()
	index := e.streams
	e.streams++
	var streamErr error
	if index < len(e.streamErrors) {
		streamErr = e.streamErrors[index]
	}
	e.mu.Unlock()

	chunks := make(chan cliproxyexecutor.StreamChunk, 1)
	if streamErr != nil {
		chunks <- cliproxyexecutor.StreamChunk{Err: streamErr}
	} else {
		chunks <- cliproxyexecutor.StreamChunk{Payload: []byte(`{"fixture":"ok"}`)}
	}
	close(chunks)
	return &cliproxyexecutor.StreamResult{Chunks: chunks}, nil
}

func (e *recordingExecutor) Refresh(_ context.Context, auth *coreauth.Auth) (*coreauth.Auth, error) {
	e.mu.Lock()
	e.refreshes++
	e.mu.Unlock()
	return auth, nil
}

func (e *recordingExecutor) CountTokens(context.Context, *coreauth.Auth, cliproxyexecutor.Request, cliproxyexecutor.Options) (cliproxyexecutor.Response, error) {
	return cliproxyexecutor.Response{}, nil
}

func (e *recordingExecutor) HttpRequest(context.Context, *coreauth.Auth, *http.Request) (*http.Response, error) {
	return nil, nil
}

func (e *recordingExecutor) executeCalls() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.executes
}

func (e *recordingExecutor) refreshCalls() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.refreshes
}

func (e *recordingExecutor) streamCalls() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.streams
}
