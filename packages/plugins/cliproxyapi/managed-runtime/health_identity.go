package managedruntime

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

const ManagedHealthIdentityVersion = 1

type RuntimeIdentity struct {
	WrapperBuildVersion string
}

type ManagedHealthIdentity struct {
	V                   int                `json:"v"`
	ContractVersion     string             `json:"contractVersion"`
	SDKVersion          string             `json:"sdkVersion"`
	WrapperBuildVersion string             `json:"wrapperBuildVersion"`
	Protocols           []ProviderProtocol `json:"protocols"`
	Purposes            []QualifiedPurpose `json:"purposes"`
	ModelListEnabled    bool               `json:"modelListEnabled"`
}

func (identity RuntimeIdentity) validate() error {
	if err := validateBoundedIdentity(
		identity.WrapperBuildVersion,
		128,
		"wrapper build version",
	); err != nil {
		return err
	}
	return nil
}

func validateBoundedIdentity(value string, limit int, label string) error {
	if value == "" || value != strings.TrimSpace(value) || len(value) > limit {
		return fmt.Errorf("%s is invalid", label)
	}
	return nil
}

func managedHealthIdentity(
	config Config,
	runtimeIdentity RuntimeIdentity,
) ManagedHealthIdentity {
	purposes := make([]QualifiedPurpose, len(config.AuthEntries))
	for index, entry := range config.AuthEntries {
		purposes[index] = entry.Purpose
	}
	return ManagedHealthIdentity{
		V:                   ManagedHealthIdentityVersion,
		ContractVersion:     WrapperContractVersion,
		SDKVersion:          PinnedSDKVersion,
		WrapperBuildVersion: runtimeIdentity.WrapperBuildVersion,
		Protocols:           append([]ProviderProtocol(nil), config.Protocols...),
		Purposes:            purposes,
		ModelListEnabled:    config.ModelListEnabled,
	}
}

// ManagedHealthIdentityMiddleware replaces the pinned SDK's status-only
// /healthz body at the wrapper boundary. The SDK still owns route registration;
// this middleware is the single wrapper-owned response for the allowed route.
func ManagedHealthIdentityMiddleware(
	identity ManagedHealthIdentity,
	modelsRegistered func() bool,
) gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request.URL.Path != "/healthz" {
			c.Next()
			return
		}
		if modelsRegistered == nil || !modelsRegistered() {
			c.AbortWithStatus(http.StatusServiceUnavailable)
			return
		}
		switch c.Request.Method {
		case http.MethodGet:
			c.AbortWithStatusJSON(http.StatusOK, identity)
		case http.MethodHead:
			c.Header("Content-Type", "application/json; charset=utf-8")
			c.AbortWithStatus(http.StatusOK)
		default:
			c.Next()
		}
	}
}
