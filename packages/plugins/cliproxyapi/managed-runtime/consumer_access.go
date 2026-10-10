package managedruntime

import (
	"context"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"sync"

	"github.com/gin-gonic/gin"
	cliproxy "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy"
	coreauth "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/executor"
)

const ConsumerAccessSettlementPath = "/_happier/consumer-access/settle"

// Consumer access is a private projection of the host's existing admitted
// request-auth subjects, not credential material or a second subject selector.
type consumerAccess struct {
	Token          string             `json:"token"`
	CapabilityPath string             `json:"capabilityPath"`
	Purposes       []QualifiedPurpose `json:"purposes"`
}

type consumerAccessDocument struct {
	V         int              `json:"v"`
	Consumers []consumerAccess `json:"consumers"`
}

type consumerRequestScope struct {
	path   string
	access consumerAccess
}

type consumerRequestScopeKey struct{}

func validConsumerToken(token string) bool {
	decoded, err := base64.RawURLEncoding.DecodeString(token)
	return err == nil && len(decoded) == 32 && base64.RawURLEncoding.EncodeToString(decoded) == token
}

func readConsumerAccess(path string) ([]consumerAccess, error) {
	data, err := readPrivateFile(path, 0)
	if err != nil {
		return nil, err
	}
	var document consumerAccessDocument
	if err := decodeStrictJSON(data, &document); err != nil || document.V != 1 || document.Consumers == nil {
		return nil, fmt.Errorf("consumer access document is invalid")
	}
	seen := make(map[string]struct{}, len(document.Consumers))
	for _, consumer := range document.Consumers {
		if !validConsumerToken(consumer.Token) || !filepath.IsAbs(consumer.CapabilityPath) ||
			consumer.CapabilityPath != filepath.Clean(consumer.CapabilityPath) || strings.ContainsRune(consumer.CapabilityPath, '\x00') || len(consumer.Purposes) == 0 {
			return nil, fmt.Errorf("consumer access document is invalid")
		}
		if _, exists := seen[consumer.Token]; exists {
			return nil, fmt.Errorf("consumer access document is invalid")
		}
		seen[consumer.Token] = struct{}{}
		purposes := make(map[QualifiedPurpose]struct{}, len(consumer.Purposes))
		for _, purpose := range consumer.Purposes {
			if purpose.validate() != nil {
				return nil, fmt.Errorf("consumer access document is invalid")
			}
			if _, exists := purposes[purpose]; exists {
				return nil, fmt.Errorf("consumer access document is invalid")
			}
			purposes[purpose] = struct{}{}
		}
	}
	return document.Consumers, nil
}

func findConsumer(consumers []consumerAccess, token string) (consumerAccess, bool) {
	for _, consumer := range consumers {
		if subtle.ConstantTimeCompare([]byte(token), []byte(consumer.Token)) == 1 {
			return consumer, true
		}
	}
	return consumerAccess{}, false
}

func (a consumerAccess) admits(purpose QualifiedPurpose) bool {
	for _, admitted := range a.Purposes {
		if admitted == purpose {
			return true
		}
	}
	return false
}

func (s consumerRequestScope) current() (consumerAccess, error) {
	consumers, err := readConsumerAccess(s.path)
	if err != nil {
		return consumerAccess{}, fmt.Errorf("consumer access is unavailable")
	}
	current, ok := findConsumer(consumers, s.access.Token)
	if !ok || current.CapabilityPath != s.access.CapabilityPath || len(current.Purposes) != len(s.access.Purposes) {
		return consumerAccess{}, fmt.Errorf("consumer access is no longer admitted")
	}
	for _, purpose := range s.access.Purposes {
		if !current.admits(purpose) {
			return consumerAccess{}, fmt.Errorf("consumer access is no longer admitted")
		}
	}
	return current, nil
}

func requestConsumerScope(ctx context.Context) (consumerRequestScope, bool) {
	if scope, ok := ctx.Value(consumerRequestScopeKey{}).(consumerRequestScope); ok {
		return scope, true
	}
	// Pinned SDK v7.2.95 creates its execution context separately and carries
	// the original request in this documented-by-source gin context slot.
	if c, ok := ctx.Value("gin").(*gin.Context); ok && c != nil && c.Request != nil {
		scope, ok := c.Request.Context().Value(consumerRequestScopeKey{}).(consumerRequestScope)
		return scope, ok
	}
	return consumerRequestScope{}, false
}

type consumerInflightRequest struct {
	cancel context.CancelFunc
	done   chan struct{}
}

type consumerAccessOwner struct {
	path           string
	physicalBearer string
	entries        []AuthEntry
	mu             sync.Mutex
	inflight       map[string]map[*consumerInflightRequest]struct{}
}

func newConsumerAccessOwner(config Config) *consumerAccessOwner {
	return &consumerAccessOwner{path: config.ConsumerAccessPath, physicalBearer: config.DownstreamBearer, entries: config.AuthEntries,
		inflight: make(map[string]map[*consumerInflightRequest]struct{})}
}

func exactBearer(request *http.Request) (string, bool) {
	if request == nil || hasAlternateDownstreamCredentialSource(request) {
		return "", false
	}
	values := request.Header.Values("Authorization")
	if len(values) != 1 || !strings.HasPrefix(values[0], "Bearer ") {
		return "", false
	}
	token := strings.TrimPrefix(values[0], "Bearer ")
	return token, token != "" && !strings.ContainsAny(token, " \t\r\n")
}

func (o *consumerAccessOwner) middleware() gin.HandlerFunc {
	health := StrictDownstreamBearerMiddleware(o.physicalBearer)
	return func(c *gin.Context) {
		if c.Request.URL.Path == "/healthz" {
			health(c)
			return
		}
		if c.Request.URL.Path == ConsumerAccessSettlementPath {
			o.settle(c)
			return
		}
		token, ok := exactBearer(c.Request)
		if !ok {
			c.AbortWithStatus(http.StatusUnauthorized)
			return
		}
		// Admission and settlement share this lock so a request cannot enroll
		// after a released consumer has been observed fully settled.
		o.mu.Lock()
		consumers, err := readConsumerAccess(o.path)
		if err != nil {
			o.mu.Unlock()
			c.AbortWithStatus(http.StatusServiceUnavailable)
			return
		}
		access, admitted := findConsumer(consumers, token)
		if !admitted {
			o.mu.Unlock()
			c.AbortWithStatus(http.StatusUnauthorized)
			return
		}
		ctx, cancel := context.WithCancel(c.Request.Context())
		active := &consumerInflightRequest{cancel: cancel, done: make(chan struct{})}
		if o.inflight[token] == nil {
			o.inflight[token] = make(map[*consumerInflightRequest]struct{})
		}
		o.inflight[token][active] = struct{}{}
		o.mu.Unlock()
		defer func() {
			cancel()
			o.mu.Lock()
			delete(o.inflight[token], active)
			if len(o.inflight[token]) == 0 {
				delete(o.inflight, token)
			}
			close(active.done)
			o.mu.Unlock()
		}()
		ctx = context.WithValue(ctx, consumerRequestScopeKey{}, consumerRequestScope{path: o.path, access: access})
		c.Request = c.Request.WithContext(ctx)
		if c.Request.Method == http.MethodGet && c.Request.URL.Path == "/v1/models" {
			models := make([]map[string]any, 0)
			for _, model := range cliproxy.GlobalModelRegistry().GetAvailableModels("openai") {
				id, ok := model["id"].(string)
				if !ok {
					continue
				}
				for _, entry := range o.entries {
					if access.admits(entry.Purpose) && cliproxy.GlobalModelRegistry().ClientSupportsModel(entry.ID, id) {
						// Keep the OpenAI model-list wire projection used by the
						// SDK handler, rather than expose internal model metadata.
						row := make(map[string]any)
						for _, key := range []string{"id", "object", "created", "owned_by"} {
							if value, present := model[key]; present {
								row[key] = value
							}
						}
						models = append(models, row)
						break
					}
				}
			}
			c.AbortWithStatusJSON(http.StatusOK, gin.H{"object": "list", "data": models})
			return
		}
		// The SDK's static API-key parser remains intact. Only authenticated
		// requests reach it, using the physical key internally; the consumer's
		// authority stays attached to the exact original request context.
		c.Request.Header = c.Request.Header.Clone()
		c.Request.Header.Set("Authorization", "Bearer "+o.physicalBearer)
		c.Next()
	}
}

func (o *consumerAccessOwner) settle(c *gin.Context) {
	token, ok := exactBearer(c.Request)
	if !ok || subtle.ConstantTimeCompare([]byte(token), []byte(o.physicalBearer)) != 1 {
		c.AbortWithStatus(http.StatusUnauthorized)
		return
	}
	var input struct {
		Token string `json:"token"`
	}
	decoder := json.NewDecoder(c.Request.Body)
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || !validConsumerToken(input.Token) || decoder.Decode(&struct{}{}) != io.EOF {
		c.AbortWithStatus(http.StatusBadRequest)
		return
	}
	o.mu.Lock()
	consumers, err := readConsumerAccess(o.path)
	if err != nil {
		o.mu.Unlock()
		c.AbortWithStatus(http.StatusServiceUnavailable)
		return
	}
	if _, retained := findConsumer(consumers, input.Token); retained {
		o.mu.Unlock()
		c.AbortWithStatus(http.StatusConflict)
		return
	}
	pending := make([]*consumerInflightRequest, 0, len(o.inflight[input.Token]))
	for active := range o.inflight[input.Token] {
		pending = append(pending, active)
		active.cancel()
	}
	o.mu.Unlock()
	for _, active := range pending {
		select {
		case <-active.done:
		case <-c.Request.Context().Done():
			c.Abort()
			return
		}
	}
	c.AbortWithStatusJSON(http.StatusOK, gin.H{"ok": true})
}

// This is admission filtering over SDK candidates, not pool or credential
// selection. The pinned SDK retains its real single-entry-per-family selector.
type consumerAdmissionSelector struct {
	entries  map[string]AuthEntry
	delegate coreauth.Selector
}

func (s *consumerAdmissionSelector) Pick(ctx context.Context, provider, model string, opts cliproxyexecutor.Options, auths []*coreauth.Auth) (*coreauth.Auth, error) {
	scope, ok := requestConsumerScope(ctx)
	if !ok {
		return nil, fmt.Errorf("consumer access is required")
	}
	access, err := scope.current()
	if err != nil {
		return nil, err
	}
	admitted := make([]*coreauth.Auth, 0, len(auths))
	for _, auth := range auths {
		if auth == nil {
			continue
		}
		entry, ok := s.entries[auth.ID]
		if ok && entry.Provider == Provider(auth.Provider) && access.admits(entry.Purpose) {
			admitted = append(admitted, auth)
		}
	}
	return s.delegate.Pick(ctx, provider, model, opts, admitted)
}
