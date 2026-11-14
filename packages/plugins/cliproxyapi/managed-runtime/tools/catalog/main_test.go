package main

import (
	"bytes"
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"os/exec"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

func TestGeneratedCatalogMatchesPinnedSDKSource(t *testing.T) {
	data, err := exec.Command("go", "list", "-m", "-json", sdkModule).Output()
	if err != nil {
		t.Fatal(err)
	}
	var module struct{ Dir, Version string }
	if err := json.Unmarshal(data, &module); err != nil {
		t.Fatal(err)
	}
	familyJSON, err := exec.Command("node", "--conditions=happier-source", "--experimental-strip-types", "../../../tools/catalog/generate.mjs", "--print-families").Output()
	if err != nil {
		t.Fatal(err)
	}
	families, err := readFamilies(bytes.NewReader(familyJSON))
	if err != nil {
		t.Fatal(err)
	}
	want, err := generate(module.Dir, module.Version, families)
	if err != nil {
		t.Fatal(err)
	}
	var rows map[string][]struct {
		ID                  string            `json:"id"`
		ContextWindowTokens int               `json:"contextWindowTokens"`
		Capabilities        map[string]string `json:"capabilities"`
		ModelOptions        []struct {
			ID      string `json:"id"`
			Options []struct {
				Value string `json:"value"`
			} `json:"options"`
		} `json:"modelOptions"`
	}
	modelJSON := strings.SplitN(string(want), "export const CLIPROXYAPI_STATIC_MODELS = ", 2)[1]
	if err := json.Unmarshal([]byte(strings.SplitN(modelJSON, " satisfies ", 2)[0]), &rows); err != nil {
		t.Fatal(err)
	}
	if len(rows["meta"]) == 0 {
		t.Fatal("managed Meta family is missing its pinned SDK compatibility catalog")
	}
	for _, row := range rows["meta"] {
		if strings.HasPrefix(row.ID, "muse-spark-") && row.ContextWindowTokens != 1048576 {
			t.Errorf("%s context window = %d, want declared 1048576", row.ID, row.ContextWindowTokens)
		}
	}
	for provider, models := range rows {
		for _, model := range models {
			wantCapability := "unknown"
			if len(model.ModelOptions) > 0 {
				wantCapability = "supported"
			}
			if model.Capabilities["reasoningControls"] != wantCapability {
				t.Errorf("%s/%s reasoningControls = %q, want %q for declared effort options", provider, model.ID, model.Capabilities["reasoningControls"], wantCapability)
			}
		}
	}
	images := map[string]bool{
		"gpt-image-1.5": false, "gpt-image-2": false,
		"gpt-image-2.5": false, "gpt-image-2.5-flare": false, "gpt-image-2.5-sunburst": false,
		"gpt-image-2.6": false, "gpt-image-2.6-flare": false, "gpt-image-2.6-sunburst": false,
	}
	foundEffortModel := false
	for _, row := range rows["codex"] {
		if _, image := images[row.ID]; image {
			images[row.ID] = true
			if row.Capabilities["toolRoundTrips"] != "unsupported" {
				t.Errorf("image model %s toolRoundTrips = %q, want unsupported", row.ID, row.Capabilities["toolRoundTrips"])
			}
		} else if row.Capabilities["toolRoundTrips"] != "unknown" {
			t.Errorf("chat model %s must retain unknown tool support", row.ID)
		}
		if row.ID != "gpt-6.1-sol" {
			continue
		}
		foundEffortModel = true
		var levels []string
		for _, option := range row.ModelOptions {
			if option.ID == "reasoning_effort" {
				for _, choice := range option.Options {
					levels = append(levels, choice.Value)
				}
			}
		}
		if !reflect.DeepEqual(levels, []string{"low", "medium", "high", "xhigh", "max"}) {
			t.Fatalf("generated gpt-6.1-sol effort choices = %v, want exact pinned SDK levels", levels)
		}
	}
	if !foundEffortModel {
		t.Error("missing pinned gpt-6.1-sol effort model")
	}
	for id, found := range images {
		if !found {
			t.Errorf("missing pinned image model %s", id)
		}
	}
	t.Run("Go health SDK identity follows the selected module", func(t *testing.T) {
		file, err := parser.ParseFile(token.NewFileSet(), "../../sdk_version.generated.go", nil, 0)
		if err != nil {
			t.Fatalf("generated SDK version is missing or invalid: %v; run node --experimental-strip-types ./tools/catalog/generate.mjs from the plugin root", err)
		}
		for _, declaration := range file.Decls {
			constants, ok := declaration.(*ast.GenDecl)
			if !ok || constants.Tok != token.CONST {
				continue
			}
			for _, spec := range constants.Specs {
				entry := spec.(*ast.ValueSpec)
				for index, name := range entry.Names {
					if name.Name != "pinnedSDKVersion" {
						continue
					}
					literal, ok := entry.Values[index].(*ast.BasicLit)
					if !ok || literal.Kind != token.STRING {
						t.Fatal("generated pinnedSDKVersion must be a string literal")
					}
					version, err := strconv.Unquote(literal.Value)
					if err != nil || version != module.Version {
						t.Fatalf("health SDK version = %q, selected module = %q; regenerate the catalog", version, module.Version)
					}
					return
				}
			}
		}
		t.Fatal("generated health SDK version is missing pinnedSDKVersion")
	})
	got, err := os.ReadFile("../../../src/provider/staticModels.generated.ts")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatal("static model output is stale: run node --experimental-strip-types ./tools/catalog/generate.mjs from the plugin root")
	}
	wantFamilies, err := generateFamilies(families)
	if err != nil {
		t.Fatal(err)
	}
	gotFamilies, err := os.ReadFile("../../families.generated.go")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(gotFamilies, wantFamilies) {
		t.Fatal("managed family output is stale: run node --experimental-strip-types ./tools/catalog/generate.mjs from the plugin root")
	}
	rowsForRuntime, err := generateRows(module.Dir, families)
	if err != nil {
		t.Fatal(err)
	}
	wantRuntime, err := generateRuntimeModels(rowsForRuntime)
	if err != nil {
		t.Fatal(err)
	}
	gotRuntime, err := os.ReadFile("../../static_models.generated.go")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(gotRuntime, wantRuntime) {
		t.Fatal("managed runtime static models are stale: run node --conditions=happier-source --experimental-strip-types ./tools/catalog/generate.mjs from the plugin root")
	}
	families[0].SDK.Catalog.Getter = "GetMissingManagedCatalog"
	if _, err := generate(module.Dir, module.Version, families); err == nil || !strings.Contains(err.Error(), "GetMissingManagedCatalog") {
		t.Fatalf("unknown SDK getter must identify the failing family accessor: %v", err)
	}
}
