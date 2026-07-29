package managedruntime

import (
	"fmt"
	"net/http"

	"github.com/gin-gonic/gin"
)

type Surface string

type ProviderProtocol string

const (
	ProtocolOpenAIChat      ProviderProtocol = "openai-chat"
	ProtocolOpenAIResponses ProviderProtocol = "openai-responses"
	ProtocolAnthropic       ProviderProtocol = "anthropic"
)

const (
	SurfaceOpenAIChat               Surface = "openai-chat-completions"
	SurfaceOpenAIResponses          Surface = "openai-responses"
	SurfaceOpenAIResponsesWebSocket Surface = "openai-responses-websocket"
	SurfaceAnthropicMessages        Surface = "anthropic-messages"
	SurfaceAnthropicCountTokens     Surface = "anthropic-count-tokens"
	SurfaceModelList                Surface = "model-list"
)

type Route struct {
	Method string
	Path   string
}

var surfaceRoutes = map[Surface][]Route{
	SurfaceOpenAIChat: {
		{Method: http.MethodPost, Path: "/v1/chat/completions"},
	},
	SurfaceOpenAIResponses: {
		{Method: http.MethodPost, Path: "/v1/responses"},
	},
	SurfaceOpenAIResponsesWebSocket: {
		{Method: http.MethodGet, Path: "/v1/responses"},
	},
	SurfaceAnthropicMessages: {
		{Method: http.MethodPost, Path: "/v1/messages"},
	},
	SurfaceAnthropicCountTokens: {
		{Method: http.MethodPost, Path: "/v1/messages/count_tokens"},
	},
	SurfaceModelList: {
		{Method: http.MethodGet, Path: "/v1/models"},
	},
}

var protocolSurfaces = map[ProviderProtocol][]Surface{
	ProtocolOpenAIChat: {
		SurfaceOpenAIChat,
	},
	ProtocolOpenAIResponses: {
		SurfaceOpenAIResponses,
		SurfaceOpenAIResponsesWebSocket,
	},
	ProtocolAnthropic: {
		SurfaceAnthropicMessages,
		SurfaceAnthropicCountTokens,
	},
}

func ServingRoutesForProtocols(protocols []ProviderProtocol) (map[Route]struct{}, error) {
	return servingRoutesForProtocols(protocols, false)
}

func servingRoutesForProtocols(protocols []ProviderProtocol, modelListEnabled bool) (map[Route]struct{}, error) {
	if len(protocols) == 0 {
		return nil, fmt.Errorf("at least one Provider protocol is required")
	}
	seenProtocols := make(map[ProviderProtocol]struct{}, len(protocols))
	seenSurfaces := make(map[Surface]struct{})
	surfaces := make([]Surface, 0)
	for _, protocol := range protocols {
		if _, exists := seenProtocols[protocol]; exists {
			return nil, fmt.Errorf("Provider protocol %q is duplicated", protocol)
		}
		seenProtocols[protocol] = struct{}{}
		mapped, ok := protocolSurfaces[protocol]
		if !ok {
			return nil, fmt.Errorf("Provider protocol %q is unsupported", protocol)
		}
		for _, surface := range mapped {
			if _, exists := seenSurfaces[surface]; exists {
				continue
			}
			seenSurfaces[surface] = struct{}{}
			surfaces = append(surfaces, surface)
		}
	}
	if modelListEnabled {
		surfaces = append(surfaces, SurfaceModelList)
	}
	return ServingRoutes(surfaces)
}

func ServingRoutes(surfaces []Surface) (map[Route]struct{}, error) {
	routes := map[Route]struct{}{
		{Method: http.MethodGet, Path: "/healthz"}:  {},
		{Method: http.MethodHead, Path: "/healthz"}: {},
	}
	seen := make(map[Surface]struct{}, len(surfaces))
	for _, surface := range surfaces {
		if _, exists := seen[surface]; exists {
			return nil, fmt.Errorf("model-serving surface %q is duplicated", surface)
		}
		seen[surface] = struct{}{}
		configured, ok := surfaceRoutes[surface]
		if !ok {
			return nil, fmt.Errorf("model-serving surface %q is unsupported", surface)
		}
		for _, route := range configured {
			routes[route] = struct{}{}
		}
	}
	return routes, nil
}

func StrictServingMiddleware(routes map[Route]struct{}) gin.HandlerFunc {
	allowed := make(map[Route]struct{}, len(routes))
	for route := range routes {
		allowed[route] = struct{}{}
	}
	return func(c *gin.Context) {
		route := Route{Method: c.Request.Method, Path: c.Request.URL.Path}
		if _, ok := allowed[route]; !ok {
			c.AbortWithStatus(http.StatusNotFound)
			return
		}
		c.Next()
	}
}
