VERDICT: REAL DEFECT — fixed at the shared managed configurator owner.

Census: summary/Create verdict is owned by `ManagedMachineConfigurationViewBody.creationUnavailableReason` (facts/optionStatus); choice resolution is owned by `managedConfiguratorDimensionSelection`, `managedConfiguratorDimensionChoices`, and Protocol `projectMachineProvisionerSelectionV1`.

Producers: Lume `provider.options()` is the catalog producer (cold read and warm refresh); its image tile ids and assignments are the full references (`ghcr.io/trycua/macos:26`) and location id `home`. Tile selection writes `draft.dimensionSelection` through `selectManagedConfiguratorDimension`; the Image control reads nested `image.*` input hints from the same options Action and writes selectors. Catalog/preset launch ids are recovered by `readMachineProvisionerSelectionForLaunchV1`; no stale revision or second catalog was observed.

Cause: Lume rows assign the root `image` object, while the shared form fields are nested (`image.kind`, `image.id`, carrier fields). The renderer only compared exact paths, so the selected tile did not own those descendants. The required Image control remained `Choose…`; blank size inputs plus that unresolved required field made facts null and selected the generic “This choice is no longer available.” summary. R115 shows the same three catalog rows and `home` on both cold/warm reads, with no native action error.

Fix/commit: added canonical `managedConfiguratorChoiceOwnsField()` (root assignment owns descendants) and used it when suppressing fields already decided by choice sections. No Lume consumer workaround or second resolver.

Evidence: R115 `qa-shots5/r115/lume-settled-state.json`, `lume-selected-confirm.json`, `lume-real-select.json`, `mac-catalog-state.json`, and `lume-diagnostics.json`; source `packages/plugins/machine-lume/src/machine/provider.ts` and `apps/ui/sources/components/settings/machines/managed/ManagedMachineConfigurationView.tsx`.

Validation: UI managed configurator 54/54 passed; Lume provider 30/30 passed; targeted managed view Lume schema/options test passed; `pnpm check:entry-loads` passed all 7 graphs. Initial direct Vitest invocation was setup-invalid (alias resolution), then rerun through `pnpm --dir apps/ui exec vitest`.

Residual: live R115 Create→Ready was not replayed after the fix, so one-VM live proof remains outstanding; no VM was created in diagnosis. No typecheck or stack lifecycle was run.
