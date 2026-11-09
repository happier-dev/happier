package managedruntime

import (
	"context"
	"crypto/sha256"
	"fmt"
	"reflect"
	"strings"

	cliproxy "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

// These are projections of the host's admitted observation, not another
// discovery or entitlement owner. Absence retains the unverified SDK fallback;
// a present empty observation admits no models for its exact purpose.
type sourceModel struct {
	ID   string `json:"id"`
	Name string `json:"name,omitempty"`
}

type sourceModelCatalog struct {
	Purpose        QualifiedPurpose `json:"purpose"`
	SourceRevision string           `json:"sourceRevision"`
	Models         []sourceModel    `json:"models"`
}

func (a consumerAccess) modelCatalog(purpose QualifiedPurpose) (sourceModelCatalog, bool) {
	for _, catalog := range a.ModelCatalogs {
		if catalog.Purpose == purpose {
			return catalog, true
		}
	}
	return sourceModelCatalog{}, false
}

func (a consumerAccess) validateModelCatalogs() error {
	seen := make(map[QualifiedPurpose]struct{}, len(a.ModelCatalogs))
	for _, catalog := range a.ModelCatalogs {
		if !a.admits(catalog.Purpose) || strings.TrimSpace(catalog.SourceRevision) == "" || catalog.Models == nil {
			return fmt.Errorf("consumer model catalog is invalid")
		}
		if _, duplicate := seen[catalog.Purpose]; duplicate {
			return fmt.Errorf("consumer model catalog purpose is duplicated")
		}
		seen[catalog.Purpose] = struct{}{}
		ids := make(map[string]struct{}, len(catalog.Models))
		for _, model := range catalog.Models {
			if model.ID == "" || model.ID != strings.TrimSpace(model.ID) {
				return fmt.Errorf("consumer model id is invalid")
			}
			if _, duplicate := ids[model.ID]; duplicate {
				return fmt.Errorf("consumer model id is duplicated")
			}
			ids[model.ID] = struct{}{}
		}
	}
	return nil
}

const sourceEntryAttribute = "happier_managed_entry"
const sourceConsumerAttribute = "happier_consumer_id"

func sourceConsumerID(token string) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(token)))
}

func sourceModelClientID(token, entryID string) string {
	return entryID + "-" + sourceConsumerID(token)
}

// The selector and final transport both resolve the same configured upstream.
// Dynamic SDK clients contain no credentials; the existing exact consumer
// request-auth context supplies the actual source at the final transport.
func managedEntryForAuth(entries map[string]AuthEntry, auth *coreauth.Auth) (AuthEntry, bool) {
	if entry, ok := entries[auth.ID]; ok {
		return entry, true
	}
	entry, ok := entries[auth.Attributes[sourceEntryAttribute]]
	consumerID := auth.Attributes[sourceConsumerAttribute]
	return entry, ok && consumerID != "" && auth.ID == entry.ID+"-"+consumerID
}

func consumerAdmitsAuth(access consumerAccess, entry AuthEntry, auth *coreauth.Auth) bool {
	if !access.admits(entry.Purpose) {
		return false
	}
	if _, observed := access.modelCatalog(entry.Purpose); observed {
		return auth.ID == sourceModelClientID(access.Token, entry.ID)
	}
	return auth.ID == entry.ID
}

// Registration follows the existing consumer admission/settlement lock and
// lifetime. It is not an observation cache: immutable clients are installed
// once per admitted consumer, and removed when that consumer settles.
type consumerModelRegistrations struct {
	entries    []AuthEntry
	manager    *coreauth.Manager
	registered map[string]consumerModelRegistration
}

type consumerModelRegistration struct {
	ids      []string
	catalogs []sourceModelCatalog
}

func (r *consumerModelRegistrations) install(access consumerAccess) error {
	if installed, exists := r.registered[access.Token]; exists {
		if !reflect.DeepEqual(installed.catalogs, access.ModelCatalogs) {
			return fmt.Errorf("consumer model observation changed")
		}
		return nil
	}
	ids := make([]string, 0, len(access.ModelCatalogs))
	for _, entry := range r.entries {
		catalog, observed := access.modelCatalog(entry.Purpose)
		if !observed {
			continue
		}
		auth := managedRuntimeAuth(entry)
		auth.ID = sourceModelClientID(access.Token, entry.ID)
		auth.Attributes[sourceEntryAttribute] = entry.ID
		auth.Attributes[sourceConsumerAttribute] = sourceConsumerID(access.Token)
		if _, err := r.manager.Register(coreauth.WithSkipPersist(context.Background()), auth); err != nil {
			r.registered[access.Token] = consumerModelRegistration{ids: ids}
			r.release(access.Token)
			return fmt.Errorf("consumer model registration is unavailable")
		}
		models := make([]*cliproxy.ModelInfo, 0, len(catalog.Models))
		for _, model := range catalog.Models {
			models = append(models, &cliproxy.ModelInfo{ID: model.ID, DisplayName: model.Name,
				Object: "model", Type: string(entry.Provider), OwnedBy: string(entry.Provider), UserDefined: true})
		}
		cliproxy.GlobalModelRegistry().RegisterClient(auth.ID, string(entry.Provider), models)
		r.manager.RefreshSchedulerEntry(auth.ID)
		ids = append(ids, auth.ID)
	}
	r.registered[access.Token] = consumerModelRegistration{ids: ids, catalogs: access.ModelCatalogs}
	return nil
}

func (r *consumerModelRegistrations) release(token string) {
	for _, id := range r.registered[token].ids {
		cliproxy.GlobalModelRegistry().UnregisterClient(id)
		r.manager.Remove(context.Background(), id)
	}
	delete(r.registered, token)
}

func consumerModelList(access consumerAccess, entries []AuthEntry) []map[string]any {
	models := make([]map[string]any, 0)
	for _, model := range cliproxy.GlobalModelRegistry().GetAvailableModels("openai") {
		id, ok := model["id"].(string)
		if !ok {
			continue
		}
		purposes := make([]QualifiedPurpose, 0)
		for _, entry := range entries {
			clientID := entry.ID
			if _, observed := access.modelCatalog(entry.Purpose); observed {
				clientID = sourceModelClientID(access.Token, entry.ID)
			}
			if access.admits(entry.Purpose) && cliproxy.GlobalModelRegistry().ClientSupportsModel(clientID, id) {
				purposes = append(purposes, entry.Purpose)
			}
		}
		if len(purposes) == 0 {
			continue
		}
		row := make(map[string]any)
		for _, key := range []string{"id", "object", "created", "owned_by"} {
			if value, present := model[key]; present {
				row[key] = value
			}
		}
		row["happier_connected_account_purposes"] = purposes
		models = append(models, row)
	}
	return models
}

func (r *consumerModelRegistrations) close() {
	for token := range r.registered {
		r.release(token)
	}
}
