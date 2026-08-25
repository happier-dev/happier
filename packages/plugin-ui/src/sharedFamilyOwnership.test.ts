import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { resolveHappierPopoverPlacement } from './presentation/interaction/Menu.js';

/**
 * §8.2 — the duplicate-owner audit, driven by an EXPLICIT owner mapping.
 *
 * This is the clause that stops "shared presentation" from becoming "43 core UI
 * directories and 43 plugin copies of them". A graduated family is shared only
 * when a real Happier core adapter AND a plugin adapter reach the same named
 * presentation owner, and when the predecessor it replaced is gone. A core
 * adapter may render its own host only when its portable primitive cannot own
 * required private RN props/styles and it consumes a named shared semantic
 * mechanism instead. Anything less is a plugin-only copy with unification
 * scheduled for later, which §3.10.3 calls a gate failure.
 *
 * Deliberately NOT a similarity heuristic (§8.2 forbids that): semantic
 * equivalence is a review judgement. This check is mechanical — one named owner
 * per module, both consumers present, no second mapped owner, one deterministic
 * dev mount.
 */
type CatalogDisposition = 'required' | 'deferred' | 'host-mediated';
type ProofTier = 'simple' | 'behavior-owning';
type GraduationPhase = 'graduated' | 'in-progress' | 'absent';
type PositiveConsumerKind = 'plugin-surface' | 'external-author-reference';

/**
 * The approved §6 vocabulary plus the r0.9 mounted-surface amendment, written
 * independently of both the implementation catalog and the public barrel. A
 * family cannot silently disappear by being removed from those two
 * self-consistent sources at the same time.
 */
const APPROVED_CATALOG_VOCABULARY = [
  'Screen', 'Stack', 'Row', 'ScrollArea',
  'Surface', 'Card',
  'Text', 'Heading', 'Label',
  'Icon', 'Image', 'BrandMark',
  'Divider', 'Badge', 'Metadata', 'Link',
  'Markdown', 'CodeBlock',
  'Spinner', 'Status',
  'State', 'LoadingState', 'EmptyState', 'ErrorState',
  'Button', 'IconButton',
  'Action.Execute', 'Action.Copy', 'Action.OpenExternal', 'Action.OpenSurface', 'Action.Refresh',
  'ActionPanel', 'ActionPanel.Section',
  'List', 'List.Section', 'List.Item', 'Item', 'ItemGroup',
  'List.SelectionActionBar', 'ListSelectionActionBar',
  'ListMultiSelectionProvider', 'createListMultiSelectionStore',
  'Form', 'Field', 'TextField', 'Toggle', 'Select', 'ValidationMessage',
  'Form.Field', 'Form.TextField', 'Form.Toggle', 'Form.Select', 'Form.ValidationMessage', 'Form.Actions',
  'Popover', 'Dropdown', 'Menu', 'ContextMenu',
  'Tabs', 'Tabs.Item',
  'TargetedSurface',
  'Progress', 'Banner',
  'PluginNavigation', 'Tooltip', 'Dialog', 'Sheet', 'Drawer',
  'Grid', 'Tree', 'Skeleton', 'DiffViewer', 'KeyHint',
] as const;

type DeclarativeDisposition = Readonly<{
  kind: 'node';
  node: 'text' | 'markdown' | 'stack' | 'group' | 'field' | 'status' | 'action' | 'list' | 'section' | 'item' | 'state' | 'metadata' | 'actionPanel';
  /** Exact node-local adapter that joins this catalog row to the renderer. */
  rendererSymbol: string;
}> | Readonly<{
  /**
   * A mounted-only declarative node whose physical mount is supplied by the
   * existing host rather than another declarative renderer.
   */
  kind: 'mounted-node';
  node: 'targetedSurface';
  bridgeSymbol: string;
}> | Readonly<{
  kind: 'not-applicable';
  reason: string;
}>;

type HostComposition = Readonly<{
  /** The one thin adapter shared by the React and declarative entry paths. */
  adapter: Readonly<{ module: string; symbol: string }>;
  /** The incumbent physical host that consumes the adapter's mounted request. */
  physicalHost: Readonly<{ module: string; symbol: string; callbackSymbol: string }>;
}>;

/**
 * A graduation consumer is either a maintained installed-plugin surface or
 * the controlled external-author reference source. Generated artifacts,
 * package tests, and dev galleries are supporting evidence only.
 */
type PositiveConsumer = Readonly<{
  kind: PositiveConsumerKind;
  pathFromRepoRoot: string;
}>;

/**
 * The single machine-readable presentation catalog (§6, §9 L0).
 *
 * This deliberately remains in the ownership test instead of growing a second
 * registry beside the package exports. Each public component/member names its
 * exact prop type, portable implementation owner, disposition, proof tier and
 * declarative status. `in-progress` is an honest state: it means the public
 * host tree is real, but the full core/plugin/declarative vertical has not yet
 * closed and must not be mistaken for graduation.
 */
type GraduatedFamily = Readonly<{
  /** Exact author-visible component or compound member. */
  publicName: string;
  /**
   * The exact exported type that names this member's public contract: its
   * props for a component, and the store contract it produces for the one
   * selection factory. `never` is used only for intentionally absent rows.
   */
  propTypeName: string;
  family: string;
  disposition: CatalogDisposition;
  proofTier: ProofTier;
  phase: GraduationPhase;
  publiclyExported: boolean;
  /** The single shared implementation, relative to `packages/plugin-ui/src`. */
  sharedModule: string;
  /** The portable implementation symbol the plugin adapter uses once graduated. */
  sharedSymbol: string;
  /** The author adapter module/symbol, relative to `packages/plugin-ui/src`. */
  pluginOwner: Readonly<{ module: string; symbol: string }>;
  /** Real Happier core consumers, relative to `apps/ui/sources`. */
  coreConsumers: readonly string[];
  /**
   * Optional shared adapter used by core when the primitive is intentionally
   * nested (for example Label inside Field). Both links are then proven.
   */
  coreAdapter?: Readonly<{ module: string; symbol: string }>;
  /**
   * A core adapter with private React Native props/styles may render its own
   * native host while consuming this shared semantic mechanism. This keeps the
   * portable primitive narrow without creating a second owner for its behavior.
   */
  corePresentationMechanism?: Readonly<{ module: string; symbol: string }>;
  /**
   * A maintained public-API consumer. Every graduated behavior-owning export
   * must bind one exact public render here; core adapters and sibling members
   * cannot stand in for that vertical.
   */
  positiveConsumer?: PositiveConsumer;
  /** The plugin-facing names the §8.2 dev mount must render. */
  devMountSymbols: readonly string[];
  declarative: DeclarativeDisposition;
  /**
   * Present only when a public semantic component delegates to an existing
   * app-owned physical host rather than a shared RN presentation primitive.
   */
  hostComposition?: HostComposition;
  /**
   * §8.2's forbidden predecessor symbols. Naming the former local owner keeps
   * the shared mechanism from becoming a third implementation beside it.
   */
  deletedCoreDuplicates?: readonly Readonly<{
    path: string;
    symbol: string;
  }>[];
  /** Marker/placeholder modules that must disappear with this family. */
  deletedPackagePaths?: readonly string[];
}>;

/**
 * The catalog is expanded atomically with a family. Do not add an export first
 * and plan its owner/disposition later.
 */
const GRADUATED_FAMILIES: readonly GraduatedFamily[] = [
  {
    publicName: 'Screen',
    propTypeName: 'ScreenProps',
    family: 'Layout screen',
    disposition: 'required',
    proofTier: 'simple',
    phase: 'graduated',
    publiclyExported: true,
    sharedModule: 'presentation/layout/Layout.tsx',
    sharedSymbol: 'HappierScreen',
    pluginOwner: { module: 'components/Layout.tsx', symbol: 'Screen' },
    coreConsumers: ['components/plugins/surfaces/DeclarativePluginSurface.tsx'],
    devMountSymbols: ['Screen as PluginScreen'],
    declarative: { kind: 'not-applicable', reason: 'V2 has no screen node; surface placement owns the outer container.' },
  },
  {
    publicName: 'Stack',
    propTypeName: 'StackProps',
    family: 'Layout stack',
    disposition: 'required',
    proofTier: 'simple',
    phase: 'graduated',
    publiclyExported: true,
    sharedModule: 'presentation/layout/Layout.tsx',
    sharedSymbol: 'HappierStack',
    pluginOwner: { module: 'components/Layout.tsx', symbol: 'Stack' },
    coreConsumers: ['components/plugins/shared/declarativeNodes.tsx'],
    devMountSymbols: ['Stack as PluginStack'],
    declarative: { kind: 'node', node: 'stack', rendererSymbol: 'HappierStack' },
  },
  {
    publicName: 'Row',
    propTypeName: 'RowProps',
    family: 'Layout row',
    disposition: 'required',
    proofTier: 'simple',
    phase: 'graduated',
    publiclyExported: true,
    sharedModule: 'presentation/layout/Layout.tsx',
    sharedSymbol: 'HappierStack',
    pluginOwner: { module: 'components/Layout.tsx', symbol: 'Row' },
    coreConsumers: ['components/plugins/shared/declarativeNodes.tsx'],
    devMountSymbols: ['Row as PluginRow'],
    declarative: { kind: 'not-applicable', reason: 'V2 horizontal stack disposition is carried by the stack node.' },
  },
  {
    publicName: 'ScrollArea',
    propTypeName: 'ScrollAreaProps',
    family: 'Layout scroll',
    disposition: 'required',
    proofTier: 'simple',
    phase: 'graduated',
    publiclyExported: true,
    sharedModule: 'presentation/layout/Layout.tsx',
    sharedSymbol: 'HappierScrollArea',
    pluginOwner: { module: 'components/Layout.tsx', symbol: 'ScrollArea' },
    coreConsumers: ['components/plugins/surfaces/DeclarativePluginSurface.tsx'],
    devMountSymbols: ['ScrollArea as PluginScrollArea'],
    declarative: { kind: 'not-applicable', reason: 'V2 has no scroll-owner node.' },
  },
  {
    publicName: 'Text',
    propTypeName: 'TextProps',
    family: 'Text',
    disposition: 'required',
    proofTier: 'simple',
    phase: 'graduated',
    publiclyExported: true,
    sharedModule: 'presentation/text/Text.tsx',
    sharedSymbol: 'HappierText',
    pluginOwner: { module: 'components/Text.tsx', symbol: 'Text' },
    coreConsumers: ['components/ui/text/Text.tsx'],
    corePresentationMechanism: { module: 'presentation/text/Text.tsx', symbol: 'useHappierTextPresentation' },
    devMountSymbols: ['Text as PluginText'],
    declarative: { kind: 'node', node: 'text', rendererSymbol: 'Text' },
  },
  {
    publicName: 'Spinner',
    propTypeName: 'SpinnerProps',
    family: 'Spinner',
    disposition: 'required',
    proofTier: 'simple',
    phase: 'graduated',
    publiclyExported: true,
    sharedModule: 'presentation/feedback/Spinner.tsx',
    sharedSymbol: 'HappierSpinner',
    pluginOwner: { module: 'components/Spinner.tsx', symbol: 'Spinner' },
    coreConsumers: ['components/ui/feedback/ActivitySpinner.tsx'],
    corePresentationMechanism: { module: 'presentation/feedback/Spinner.tsx', symbol: 'resolveHappierWebSpinnerPresentation' },
    devMountSymbols: ['Spinner as PluginSpinner'],
    declarative: { kind: 'not-applicable', reason: 'V2 has status, not a standalone spinner node.' },
  },
  {
    publicName: 'Status',
    propTypeName: 'StatusProps',
    family: 'Status',
    disposition: 'required',
    proofTier: 'simple',
    phase: 'graduated',
    publiclyExported: true,
    sharedModule: 'presentation/status/Status.tsx',
    sharedSymbol: 'HappierStatus',
    pluginOwner: { module: 'components/Status.tsx', symbol: 'Status' },
    coreConsumers: ['components/plugins/shared/declarativeNodes.tsx'],
    devMountSymbols: ['Status as PluginStatus'],
    declarative: { kind: 'node', node: 'status', rendererSymbol: 'HappierStatus' },
  },
  {
    publicName: 'State',
    propTypeName: 'StateProps',
    family: 'InfoState',
    disposition: 'required',
    proofTier: 'simple',
    phase: 'graduated',
    publiclyExported: true,
    sharedModule: 'presentation/state/InfoState.tsx',
    sharedSymbol: 'HappierInfoState',
    pluginOwner: { module: 'components/State.tsx', symbol: 'State' },
    coreConsumers: ['components/ui/empty/EmptyState.tsx'],
    devMountSymbols: ['State as PluginState'],
    declarative: { kind: 'node', node: 'state', rendererSymbol: 'HappierInfoState' },
  },
  {
    publicName: 'LoadingState',
    propTypeName: 'LoadingStateProps',
    family: 'InfoState',
    disposition: 'required',
    proofTier: 'simple',
    phase: 'graduated',
    publiclyExported: true,
    sharedModule: 'presentation/state/InfoState.tsx',
    sharedSymbol: 'HappierInfoState',
    pluginOwner: { module: 'components/State.tsx', symbol: 'LoadingState' },
    coreConsumers: ['components/ui/empty/EmptyState.tsx'],
    devMountSymbols: ['LoadingState as PluginLoadingState'],
    declarative: { kind: 'node', node: 'state', rendererSymbol: 'HappierInfoState' },
  },
  {
    publicName: 'EmptyState',
    propTypeName: 'EmptyStateProps',
    family: 'InfoState',
    disposition: 'required',
    proofTier: 'simple',
    phase: 'graduated',
    publiclyExported: true,
    sharedModule: 'presentation/state/InfoState.tsx',
    sharedSymbol: 'HappierInfoState',
    pluginOwner: { module: 'components/State.tsx', symbol: 'EmptyState' },
    coreConsumers: ['components/ui/empty/EmptyState.tsx'],
    devMountSymbols: ['EmptyState as PluginEmptyState'],
    declarative: { kind: 'node', node: 'state', rendererSymbol: 'HappierInfoState' },
  },
  {
    publicName: 'ErrorState',
    propTypeName: 'ErrorStateProps',
    family: 'InfoState',
    disposition: 'required',
    proofTier: 'simple',
    phase: 'graduated',
    publiclyExported: true,
    sharedModule: 'presentation/state/InfoState.tsx',
    sharedSymbol: 'HappierInfoState',
    pluginOwner: { module: 'components/State.tsx', symbol: 'ErrorState' },
    coreConsumers: ['components/ui/empty/EmptyState.tsx'],
    devMountSymbols: ['ErrorState as PluginErrorState'],
    declarative: { kind: 'node', node: 'state', rendererSymbol: 'HappierInfoState' },
  },
  {
    publicName: 'Button',
    propTypeName: 'ButtonProps',
    family: 'Pressable',
    disposition: 'required',
    proofTier: 'behavior-owning',
    phase: 'graduated',
    publiclyExported: true,
    sharedModule: 'presentation/interaction/Pressable.tsx',
    sharedSymbol: 'HappierPressable',
    pluginOwner: { module: 'components/Button.tsx', symbol: 'Button' },
    coreConsumers: [
      'components/ui/buttons/IconButton.tsx',
      'components/ui/buttons/RoundButton.tsx',
    ],
    positiveConsumer: {
      kind: 'plugin-surface',
      pathFromRepoRoot: 'packages/plugins/inspector/src/ui/renderSurface.tsx',
    },
    devMountSymbols: ['Button as PluginButton'],
    declarative: { kind: 'node', node: 'action', rendererSymbol: 'renderActionAffordance' },
    // Before extraction, BOTH core buttons carried their own press→pending
    // machine: `IconButton` detected a thenable with a local `isPromiseLike` and
    // guarded reentry with a `busyRef`, while `RoundButton` ran a separate
    // `setLoading(true)` around its `action` prop. Two owners for one mechanism
    // is the split-brain this family exists to remove, so both names are
    // forbidden at their former sites.
    deletedCoreDuplicates: [
      { path: 'components/ui/buttons/IconButton.tsx', symbol: 'isPromiseLike' },
      { path: 'components/ui/buttons/RoundButton.tsx', symbol: 'setLoading' },
    ],
  },
  {
    publicName: 'IconButton',
    propTypeName: 'IconButtonProps',
    family: 'Pressable',
    disposition: 'required',
    proofTier: 'behavior-owning',
    phase: 'graduated',
    publiclyExported: true,
    sharedModule: 'presentation/interaction/Pressable.tsx',
    sharedSymbol: 'HappierPressable',
    pluginOwner: { module: 'components/Button.tsx', symbol: 'IconButton' },
    coreConsumers: ['components/ui/buttons/IconButton.tsx'],
    positiveConsumer: {
      kind: 'plugin-surface',
      pathFromRepoRoot: 'packages/plugins/inspector/src/ui/renderSurface.tsx',
    },
    devMountSymbols: ['IconButton as PluginIconButton'],
    declarative: { kind: 'not-applicable', reason: 'Declarative actions carry semantic labels; arbitrary icon-only controls are not nodes.' },
  },
  {
    publicName: 'Action.Execute',
    propTypeName: 'ActionExecuteProps',
    family: 'Action',
    disposition: 'required',
    proofTier: 'behavior-owning',
    phase: 'graduated',
    publiclyExported: true,
    sharedModule: 'presentation/interaction/Pressable.tsx',
    sharedSymbol: 'HappierPressable',
    pluginOwner: { module: 'components/Action.tsx', symbol: 'ActionExecute' },
    coreConsumers: ['components/ui/buttons/IconButton.tsx'],
    positiveConsumer: {
      kind: 'plugin-surface',
      pathFromRepoRoot: 'packages/plugins/inspector/src/ui/renderSurface.tsx',
    },
    devMountSymbols: ['Action as PluginAction'],
    declarative: { kind: 'node', node: 'action', rendererSymbol: 'renderActionAffordance' },
  },
  {
    publicName: 'Action.Copy',
    propTypeName: 'ActionCopyProps',
    family: 'Action',
    disposition: 'required',
    proofTier: 'behavior-owning',
    phase: 'graduated',
    publiclyExported: true,
    sharedModule: 'presentation/interaction/Pressable.tsx',
    sharedSymbol: 'HappierPressable',
    pluginOwner: { module: 'components/Action.tsx', symbol: 'ActionCopy' },
    coreConsumers: ['components/ui/buttons/IconButton.tsx'],
    positiveConsumer: {
      kind: 'plugin-surface',
      pathFromRepoRoot: 'packages/plugins/inspector/src/ui/renderSurface.tsx',
    },
    devMountSymbols: ['Action as PluginAction'],
    declarative: { kind: 'node', node: 'action', rendererSymbol: 'renderActionAffordance' },
  },
  {
    publicName: 'Action.OpenExternal',
    propTypeName: 'ActionOpenExternalProps',
    family: 'Action',
    disposition: 'required',
    proofTier: 'behavior-owning',
    phase: 'graduated',
    publiclyExported: true,
    sharedModule: 'presentation/interaction/Pressable.tsx',
    sharedSymbol: 'HappierPressable',
    pluginOwner: { module: 'components/Action.tsx', symbol: 'ActionOpenExternal' },
    coreConsumers: ['components/ui/buttons/IconButton.tsx'],
    positiveConsumer: {
      kind: 'plugin-surface',
      pathFromRepoRoot: 'packages/plugins/inspector/src/ui/renderSurface.tsx',
    },
    devMountSymbols: ['Action as PluginAction'],
    declarative: { kind: 'node', node: 'action', rendererSymbol: 'renderActionAffordance' },
  },
  {
    publicName: 'Action.OpenSurface',
    propTypeName: 'ActionOpenSurfaceProps',
    family: 'Action',
    disposition: 'required',
    proofTier: 'behavior-owning',
    phase: 'graduated',
    publiclyExported: true,
    sharedModule: 'presentation/interaction/Pressable.tsx',
    sharedSymbol: 'HappierPressable',
    pluginOwner: { module: 'components/Action.tsx', symbol: 'ActionOpenSurface' },
    coreConsumers: ['components/ui/buttons/IconButton.tsx'],
    positiveConsumer: {
      kind: 'plugin-surface',
      pathFromRepoRoot: 'packages/plugins/inspector/src/ui/renderSurface.tsx',
    },
    devMountSymbols: ['Action as PluginAction'],
    declarative: { kind: 'node', node: 'action', rendererSymbol: 'renderActionAffordance' },
  },
  {
    publicName: 'Action.Refresh',
    propTypeName: 'ActionRefreshProps',
    family: 'Action',
    disposition: 'required',
    proofTier: 'behavior-owning',
    phase: 'graduated',
    publiclyExported: true,
    sharedModule: 'presentation/interaction/Pressable.tsx',
    sharedSymbol: 'HappierPressable',
    pluginOwner: { module: 'components/Action.tsx', symbol: 'ActionRefresh' },
    coreConsumers: ['components/ui/buttons/IconButton.tsx'],
    positiveConsumer: {
      kind: 'plugin-surface',
      pathFromRepoRoot: 'packages/plugins/inspector/src/ui/renderSurface.tsx',
    },
    devMountSymbols: ['Action as PluginAction'],
    declarative: { kind: 'node', node: 'action', rendererSymbol: 'renderActionAffordance' },
  },
  {
    publicName: 'ActionPanel',
    propTypeName: 'ActionPanelProps',
    family: 'ActionPanel',
    disposition: 'required',
    proofTier: 'behavior-owning',
    phase: 'graduated',
    publiclyExported: true,
    sharedModule: 'presentation/interaction/ActionPanel.tsx',
    sharedSymbol: 'HappierActionPanel',
    pluginOwner: { module: 'components/Action.tsx', symbol: 'ActionPanel' },
    coreConsumers: ['components/plugins/shared/declarativeNodes.tsx'],
    positiveConsumer: {
      kind: 'plugin-surface',
      pathFromRepoRoot: 'packages/plugins/inspector/src/ui/renderSurface.tsx',
    },
    devMountSymbols: ['ActionPanel as PluginActionPanel'],
    declarative: { kind: 'node', node: 'actionPanel', rendererSymbol: 'HappierActionPanel' },
  },
  {
    publicName: 'ActionPanel.Section',
    propTypeName: 'ActionPanelSectionProps',
    family: 'ActionPanel section',
    disposition: 'required',
    proofTier: 'behavior-owning',
    phase: 'graduated',
    publiclyExported: true,
    sharedModule: 'presentation/interaction/ActionPanel.tsx',
    sharedSymbol: 'HappierActionPanelSection',
    pluginOwner: { module: 'components/Action.tsx', symbol: 'ActionPanelSection' },
    coreConsumers: ['components/plugins/shared/declarativeNodes.tsx'],
    positiveConsumer: {
      kind: 'plugin-surface',
      pathFromRepoRoot: 'packages/plugins/inspector/src/ui/renderSurface.tsx',
    },
    devMountSymbols: ['ActionPanel as PluginActionPanel'],
    declarative: { kind: 'not-applicable', reason: 'The actionPanel node owns one toolbar; public sections are nested author composition.' },
  },
  {
    publicName: 'Surface',
    propTypeName: 'SurfaceProps',
    family: 'Surface',
    disposition: 'required',
    proofTier: 'simple',
    phase: 'graduated',
    publiclyExported: true,
    sharedModule: 'presentation/layout/Surface.tsx',
    sharedSymbol: 'HappierSurface',
    pluginOwner: { module: 'components/Surface.tsx', symbol: 'Surface' },
    coreConsumers: ['components/ui/cards/SurfaceCard.tsx'],
    corePresentationMechanism: { module: 'presentation/layout/Surface.tsx', symbol: 'HappierSurface' },
    devMountSymbols: ['Surface as PluginSurface'],
    declarative: { kind: 'not-applicable', reason: 'V2 has no generic surface node.' },
    deletedPackagePaths: ['components/Panel.tsx', 'components/primitiveElement.ts'],
  },
  {
    publicName: 'Card',
    propTypeName: 'CardProps',
    family: 'Surface',
    disposition: 'required',
    proofTier: 'simple',
    phase: 'graduated',
    publiclyExported: true,
    sharedModule: 'presentation/layout/Surface.tsx',
    sharedSymbol: 'HappierSurface',
    pluginOwner: { module: 'components/Surface.tsx', symbol: 'Card' },
    coreConsumers: ['components/ui/cards/SurfaceCard.tsx'],
    corePresentationMechanism: { module: 'presentation/layout/Surface.tsx', symbol: 'HappierSurface' },
    devMountSymbols: ['Card as PluginCard'],
    declarative: { kind: 'not-applicable', reason: 'V2 has no generic card node.' },
    deletedPackagePaths: ['components/Panel.tsx', 'components/primitiveElement.ts'],
  },
  {
    publicName: 'List',
    propTypeName: 'ListProps',
    family: 'List root',
    disposition: 'required',
    proofTier: 'behavior-owning',
    phase: 'graduated',
    publiclyExported: true,
    sharedModule: 'presentation/collection/List.tsx',
    sharedSymbol: 'HappierList',
    pluginOwner: { module: 'components/List.tsx', symbol: 'List' },
    coreConsumers: ['components/plugins/shared/declarativeNodes.tsx'],
    positiveConsumer: {
      kind: 'plugin-surface',
      pathFromRepoRoot: 'packages/plugins/inspector/src/ui/renderSurface.tsx',
    },
    devMountSymbols: ['List as PluginList'],
    declarative: { kind: 'node', node: 'list', rendererSymbol: 'HappierList' },
    deletedPackagePaths: ['components/primitiveElement.ts'],
  },
  {
    publicName: 'List.Section',
    propTypeName: 'ListSectionProps',
    family: 'List section',
    disposition: 'required',
    proofTier: 'behavior-owning',
    phase: 'graduated',
    publiclyExported: true,
    sharedModule: 'presentation/collection/List.tsx',
    sharedSymbol: 'HappierListSection',
    pluginOwner: { module: 'components/List.tsx', symbol: 'ListSection' },
    coreConsumers: ['components/plugins/shared/declarativeNodes.tsx'],
    positiveConsumer: {
      kind: 'plugin-surface',
      pathFromRepoRoot: 'packages/plugins/inspector/src/ui/renderSurface.tsx',
    },
    devMountSymbols: ['List as PluginList'],
    declarative: { kind: 'node', node: 'section', rendererSymbol: 'HappierListSection' },
    deletedPackagePaths: ['components/primitiveElement.ts'],
  },
  {
    publicName: 'List.Item',
    propTypeName: 'ListItemProps',
    family: 'List item',
    disposition: 'required',
    proofTier: 'behavior-owning',
    phase: 'graduated',
    publiclyExported: true,
    sharedModule: 'presentation/collection/semantics.ts',
    sharedSymbol: 'resolveHappierItemBehavior',
    pluginOwner: { module: 'components/List.tsx', symbol: 'ListItem' },
    coreConsumers: ['components/ui/lists/Item.tsx'],
    positiveConsumer: {
      kind: 'plugin-surface',
      pathFromRepoRoot: 'packages/plugins/inspector/src/ui/renderSurface.tsx',
    },
    devMountSymbols: ['List as PluginList'],
    declarative: { kind: 'node', node: 'item', rendererSymbol: 'HappierListItem' },
    deletedPackagePaths: ['components/primitiveElement.ts'],
  },
  {
    publicName: 'Item',
    propTypeName: 'ListItemProps',
    family: 'List item',
    disposition: 'required',
    proofTier: 'behavior-owning',
    phase: 'graduated',
    publiclyExported: true,
    sharedModule: 'presentation/collection/semantics.ts',
    sharedSymbol: 'resolveHappierItemBehavior',
    pluginOwner: { module: 'components/List.tsx', symbol: 'Item' },
    coreConsumers: ['components/ui/lists/Item.tsx'],
    positiveConsumer: {
      kind: 'plugin-surface',
      pathFromRepoRoot: 'packages/plugins/inspector/src/ui/renderSurface.tsx',
    },
    devMountSymbols: ['Item as PluginItem'],
    declarative: { kind: 'node', node: 'item', rendererSymbol: 'HappierListItem' },
  },
  {
    publicName: 'ItemGroup',
    propTypeName: 'ItemGroupProps',
    family: 'Item group',
    disposition: 'required',
    proofTier: 'behavior-owning',
    phase: 'graduated',
    publiclyExported: true,
    sharedModule: 'presentation/collection/ItemGroup.tsx',
    sharedSymbol: 'HappierItemGroupBehavior',
    pluginOwner: { module: 'components/List.tsx', symbol: 'ItemGroup' },
    coreConsumers: ['components/ui/lists/ItemGroup.tsx'],
    positiveConsumer: {
      kind: 'plugin-surface',
      pathFromRepoRoot: 'packages/plugins/inspector/src/ui/renderSurface.tsx',
    },
    devMountSymbols: ['ItemGroup as PluginItemGroup'],
    declarative: { kind: 'not-applicable', reason: 'Declarative list/section own grouping without a standalone ItemGroup node.' },
  },
  /*
   * The List multi-selection capability (§6 List family, r0.31 `U-LIST-MULTISELECT`).
   *
   * Four public members, one shared owner: the keyed selection state machine in
   * `presentation/collection/multiSelection.ts`. The sessions list is the real
   * core adapter — it was EXTRACTED onto this owner, not copied beside it, and
   * `deletedCoreDuplicates` below is what keeps its local reducer, range,
   * pointer and snapshot implementations from coming back.
   *
   * The committed Triage bulk surface directly renders the compound action
   * bar below, proving that source-adoption half without falsely crediting its
   * sibling aliases. This family remains `in-progress` until the separate
   * packed-platform evidence exists.
   */
  {
    publicName: 'createListMultiSelectionStore',
    propTypeName: 'ListMultiSelectionStore',
    family: 'List multi-selection',
    disposition: 'required',
    proofTier: 'behavior-owning',
    phase: 'in-progress',
    publiclyExported: true,
    sharedModule: 'presentation/collection/multiSelection.ts',
    sharedSymbol: 'createHappierListMultiSelectionStore',
    pluginOwner: { module: 'components/ListMultiSelection.tsx', symbol: 'createListMultiSelectionStore' },
    coreConsumers: ['components/sessions/shell/selection/SessionListSelectionContext.tsx'],
    devMountSymbols: [],
    declarative: { kind: 'not-applicable', reason: 'V2 has no bulk-selection node; a declarative list exposes no author-owned selection store.' },
    deletedCoreDuplicates: [
      { path: 'components/sessions/shell/selection/sessionListSelectionReducer.ts', symbol: 'pruneState' },
      { path: 'components/sessions/shell/selection/sessionListSelectionRange.ts', symbol: 'isEligible' },
      { path: 'components/sessions/shell/selection/sessionListSelectionPointer.ts', symbol: 'isApplePlatform' },
      { path: 'components/sessions/shell/selection/SessionListSelectionContext.tsx', symbol: 'createSnapshot' },
    ],
  },
  {
    publicName: 'ListMultiSelectionProvider',
    propTypeName: 'ListMultiSelectionProviderProps',
    family: 'List multi-selection',
    disposition: 'required',
    proofTier: 'behavior-owning',
    phase: 'in-progress',
    publiclyExported: true,
    sharedModule: 'presentation/collection/multiSelection.ts',
    sharedSymbol: 'createHappierListMultiSelectionStore',
    pluginOwner: { module: 'components/ListMultiSelection.tsx', symbol: 'ListMultiSelectionProvider' },
    coreConsumers: ['components/sessions/shell/selection/SessionListSelectionContext.tsx'],
    devMountSymbols: [],
    declarative: { kind: 'not-applicable', reason: 'V2 has no bulk-selection node; the mounted List publishes the store itself.' },
  },
  {
    publicName: 'ListSelectionActionBar',
    propTypeName: 'ListSelectionActionBarProps',
    family: 'List multi-selection',
    disposition: 'required',
    proofTier: 'behavior-owning',
    phase: 'in-progress',
    publiclyExported: true,
    sharedModule: 'presentation/collection/multiSelection.ts',
    sharedSymbol: 'createHappierListMultiSelectionStore',
    pluginOwner: { module: 'components/ListMultiSelection.tsx', symbol: 'ListSelectionActionBar' },
    coreConsumers: ['components/sessions/shell/selection/SessionListSelectionContext.tsx'],
    devMountSymbols: [],
    declarative: { kind: 'not-applicable', reason: 'V2 has no bulk-action node; a declarative surface reaches bulk work through Actions.' },
  },
  {
    publicName: 'List.SelectionActionBar',
    propTypeName: 'ListSelectionActionBarProps',
    family: 'List multi-selection',
    disposition: 'required',
    proofTier: 'behavior-owning',
    phase: 'in-progress',
    publiclyExported: true,
    sharedModule: 'presentation/collection/multiSelection.ts',
    sharedSymbol: 'createHappierListMultiSelectionStore',
    pluginOwner: { module: 'components/ListMultiSelection.tsx', symbol: 'ListSelectionActionBar' },
    coreConsumers: ['components/sessions/shell/selection/SessionListSelectionContext.tsx'],
    positiveConsumer: {
      kind: 'plugin-surface',
      pathFromRepoRoot: 'packages/plugins/triage/src/ui/list/BulkActionBar.tsx',
    },
    devMountSymbols: [],
    declarative: { kind: 'not-applicable', reason: 'V2 has no bulk-action node; a declarative surface reaches bulk work through Actions.' },
  },
  {
    publicName: 'Heading',
    propTypeName: 'HeadingProps',
    family: 'Heading',
    disposition: 'required',
    proofTier: 'simple',
    phase: 'graduated',
    publiclyExported: true,
    sharedModule: 'presentation/content/Foundation.tsx',
    sharedSymbol: 'HappierHeading',
    pluginOwner: { module: 'components/Foundation.tsx', symbol: 'Heading' },
    coreConsumers: ['components/plugins/shared/declarativeNodes.tsx'],
    devMountSymbols: ['Heading as PluginHeading'],
    declarative: { kind: 'not-applicable', reason: 'V2 text/group nodes carry heading semantics without a heading node.' },
  },
  {
    publicName: 'Label',
    propTypeName: 'LabelProps',
    family: 'Label',
    disposition: 'required',
    proofTier: 'simple',
    phase: 'graduated',
    publiclyExported: true,
    sharedModule: 'presentation/content/Foundation.tsx',
    sharedSymbol: 'HappierLabel',
    pluginOwner: { module: 'components/Foundation.tsx', symbol: 'Label' },
    coreConsumers: ['components/sessions/actions/ActionInputFields.tsx'],
    coreAdapter: { module: 'presentation/form/Fields.tsx', symbol: 'HappierField' },
    devMountSymbols: ['Label as PluginLabel'],
    declarative: { kind: 'not-applicable', reason: 'V2 field/group labels are projected by their owning adapters.' },
  },
  {
    publicName: 'Divider',
    propTypeName: 'DividerProps',
    family: 'Divider',
    disposition: 'required',
    proofTier: 'simple',
    phase: 'graduated',
    publiclyExported: true,
    sharedModule: 'presentation/content/Foundation.tsx',
    sharedSymbol: 'HappierDivider',
    pluginOwner: { module: 'components/Foundation.tsx', symbol: 'Divider' },
    coreConsumers: ['components/ui/lists/Item.tsx'],
    devMountSymbols: ['Divider as PluginDivider'],
    declarative: { kind: 'not-applicable', reason: 'V2 sections own row separation; there is no free divider node.' },
  },
  {
    publicName: 'Badge',
    propTypeName: 'BadgeProps',
    family: 'Badge',
    disposition: 'required',
    proofTier: 'simple',
    phase: 'graduated',
    publiclyExported: true,
    sharedModule: 'presentation/content/Foundation.tsx',
    sharedSymbol: 'HappierBadge',
    pluginOwner: { module: 'components/Foundation.tsx', symbol: 'Badge' },
    coreConsumers: ['components/profiles/ProfileRequirementsBadge.tsx'],
    devMountSymbols: ['Badge as PluginBadge'],
    declarative: { kind: 'not-applicable', reason: 'V2 has no badge node.' },
  },
  {
    publicName: 'Metadata',
    propTypeName: 'MetadataProps',
    family: 'Metadata',
    disposition: 'required',
    proofTier: 'simple',
    phase: 'graduated',
    publiclyExported: true,
    sharedModule: 'presentation/content/Foundation.tsx',
    sharedSymbol: 'HappierMetadata',
    pluginOwner: { module: 'components/Foundation.tsx', symbol: 'Metadata' },
    coreConsumers: ['components/plugins/shared/declarativeNodes.tsx'],
    devMountSymbols: ['Metadata as PluginMetadata'],
    declarative: { kind: 'node', node: 'metadata', rendererSymbol: 'HappierMetadata' },
  },
  {
    publicName: 'Link',
    propTypeName: 'LinkProps',
    family: 'Link',
    disposition: 'required',
    proofTier: 'simple',
    phase: 'graduated',
    publiclyExported: true,
    sharedModule: 'presentation/content/Foundation.tsx',
    sharedSymbol: 'HappierLink',
    pluginOwner: { module: 'components/Foundation.tsx', symbol: 'Link' },
    coreConsumers: ['components/settings/providers/ProviderExternalLinkItem.tsx'],
    devMountSymbols: ['Link as PluginLink'],
    declarative: { kind: 'not-applicable', reason: 'External opening remains an Action/host capability, not declarative raw URL navigation.' },
  },
  {
    publicName: 'Progress',
    propTypeName: 'ProgressProps',
    family: 'Progress',
    disposition: 'required',
    proofTier: 'behavior-owning',
    phase: 'in-progress',
    publiclyExported: true,
    sharedModule: 'presentation/content/Foundation.tsx',
    sharedSymbol: 'HappierProgress',
    pluginOwner: { module: 'components/Foundation.tsx', symbol: 'Progress' },
    coreConsumers: ['components/browser/BrowserLoadProgressBar.tsx'],
    positiveConsumer: {
      kind: 'plugin-surface',
      pathFromRepoRoot: 'packages/plugins/inspector/src/ui/renderSurface.tsx',
    },
    devMountSymbols: ['Progress as PluginProgress'],
    declarative: { kind: 'not-applicable', reason: 'V2 status carries copy but has no numeric progress node.' },
  },
  {
    publicName: 'Banner',
    propTypeName: 'BannerProps',
    family: 'Banner',
    disposition: 'required',
    proofTier: 'behavior-owning',
    phase: 'graduated',
    publiclyExported: true,
    sharedModule: 'presentation/content/Foundation.tsx',
    sharedSymbol: 'HappierBanner',
    pluginOwner: { module: 'components/Foundation.tsx', symbol: 'Banner' },
    coreConsumers: ['components/sessions/shell/view/WarningActionBanner.tsx'],
    positiveConsumer: {
      kind: 'plugin-surface',
      pathFromRepoRoot: 'packages/plugins/inspector/src/ui/renderSurface.tsx',
    },
    devMountSymbols: ['Banner as PluginBanner'],
    declarative: { kind: 'not-applicable', reason: 'V2 state/status nodes are adapted to banner semantics only where their host placement owns it.' },
  },
  {
    publicName: 'Icon',
    propTypeName: 'IconProps',
    family: 'Icon',
    disposition: 'required',
    proofTier: 'simple',
    phase: 'graduated',
    publiclyExported: true,
    sharedModule: 'presentation/content/Icon.ts',
    sharedSymbol: 'resolveHappierIconSize',
    pluginOwner: { module: 'components/Icon.tsx', symbol: 'Icon' },
    coreConsumers: ['components/ui/icons/Icon.tsx'],
    devMountSymbols: ['Icon as PluginIcon'],
    declarative: { kind: 'not-applicable', reason: 'Declarative descriptors carry only host-owned semantic icon facts.' },
  },
  ...([
    ['Image', 'ImageProps'],
    ['BrandMark', 'BrandMarkProps'],
  ] as const).map(([publicName, propTypeName]) => ({
    publicName,
    propTypeName,
    family: `Image and brand ${publicName}`,
    disposition: 'required' as const,
    proofTier: 'behavior-owning' as const,
    phase: 'in-progress' as const,
    publiclyExported: true,
    sharedModule: 'presentation/content/Image.tsx',
    sharedSymbol: publicName === 'Image' ? 'resolveHappierImagePixels' : 'HappierBrandMark',
    pluginOwner: { module: 'components/Image.tsx', symbol: publicName },
    coreConsumers: publicName === 'Image'
      ? []
      : [
          'components/plugins/permissions/PluginPermissionGrantSheet.tsx',
          'components/plugins/shared/InstalledPluginBrandMark.tsx',
        ],
    positiveConsumer: {
      kind: 'plugin-surface',
      pathFromRepoRoot: 'packages/plugins/inspector/src/ui/renderSurface.tsx',
    },
    devMountSymbols: publicName === 'Image' ? ['Image as PluginImage'] : ['BrandMark as PluginBrandMark'],
    declarative: { kind: 'not-applicable' as const, reason: 'Package images are admitted Resources, not arbitrary declarative URLs.' },
  })),
  {
    publicName: 'Markdown',
    propTypeName: 'MarkdownProps',
    family: 'Markdown',
    disposition: 'required',
    proofTier: 'behavior-owning',
    phase: 'graduated',
    publiclyExported: true,
    sharedModule: 'presentation/content/Markdown.tsx',
    sharedSymbol: 'HappierMarkdown',
    pluginOwner: { module: 'components/Content.tsx', symbol: 'Markdown' },
    coreConsumers: ['components/plugins/shared/declarativeNodes.tsx'],
    positiveConsumer: {
      kind: 'plugin-surface',
      pathFromRepoRoot: 'packages/plugins/inspector/src/ui/renderSurface.tsx',
    },
    devMountSymbols: ['Markdown as PluginMarkdown'],
    declarative: { kind: 'node', node: 'markdown', rendererSymbol: 'HappierMarkdown' },
  },
  {
    publicName: 'CodeBlock',
    propTypeName: 'CodeBlockProps',
    family: 'Code',
    disposition: 'required',
    proofTier: 'behavior-owning',
    phase: 'graduated',
    publiclyExported: true,
    sharedModule: 'presentation/content/CodeBlock.ts',
    sharedSymbol: 'useHappierCodeBlockBehavior',
    pluginOwner: { module: 'components/Content.tsx', symbol: 'CodeBlock' },
    coreConsumers: ['components/ui/code/blocks/CodeBlockViewFrame.tsx'],
    positiveConsumer: {
      kind: 'plugin-surface',
      pathFromRepoRoot: 'packages/plugins/inspector/src/ui/renderSurface.tsx',
    },
    devMountSymbols: ['CodeBlock as PluginCodeBlock'],
    declarative: { kind: 'not-applicable', reason: 'Preview V2 has Markdown but no standalone code-block node.' },
  },
  ...(['Popover', 'Menu', 'Dropdown', 'ContextMenu'] as const).map((publicName) => ({
    publicName,
    propTypeName: publicName === 'Popover' ? 'PopoverProps' : 'MenuProps',
    family: publicName === 'Popover' ? 'Popover' : 'Menu',
    disposition: 'required' as const,
    proofTier: 'behavior-owning' as const,
    phase: 'graduated' as const,
    publiclyExported: true,
    sharedModule: 'presentation/interaction/Menu.ts',
    sharedSymbol: publicName === 'Popover' ? 'resolveHappierPopoverPlacement' : 'useHappierMenuInteraction',
    pluginOwner: { module: 'components/Overlay.tsx', symbol: publicName },
    coreConsumers: [publicName === 'Popover'
      ? 'components/ui/popover/Popover.tsx'
      : 'components/ui/forms/dropdown/useSelectableMenu.ts'],
    positiveConsumer: {
      kind: 'external-author-reference',
      pathFromRepoRoot: 'packages/plugin-ui/fixtures/external-authoring/src/Surface.tsx',
    },
    devMountSymbols: [`${publicName} as Plugin${publicName}`],
    declarative: { kind: 'not-applicable' as const, reason: 'Overlay nodes remain semantic ActionPanel/Select adapters, not arbitrary portal content.' },
  })),
  {
    publicName: 'Form',
    propTypeName: 'FormProps',
    family: 'Form root',
    disposition: 'required',
    proofTier: 'behavior-owning',
    phase: 'graduated',
    publiclyExported: true,
    // FormRoot owns the public callback-to-pending projection. Happier core's
    // Action form has a different producer, but consumes the same semantic
    // pending resolver rather than maintaining a parallel editability rule.
    sharedModule: 'presentation/form/Fields.tsx',
    sharedSymbol: 'resolveHappierFormPending',
    pluginOwner: { module: 'components/Form.tsx', symbol: 'FormRoot' },
    coreConsumers: ['components/plugins/actions/ActionInputFormModal.tsx'],
    positiveConsumer: {
      kind: 'external-author-reference',
      pathFromRepoRoot: 'packages/plugin-ui/fixtures/external-authoring/src/Surface.tsx',
    },
    devMountSymbols: ['Form as PluginForm'],
    declarative: {
      kind: 'not-applicable',
      reason: 'Declarative settings fields consume the shared field controls; they do not own an author callback form root.',
    },
  },
  ...([
    ['Field', 'FieldProps', 'Field', 'field'],
    ['TextField', 'TextFieldProps', 'TextField', 'field'],
    ['Toggle', 'ToggleProps', 'Toggle', 'field'],
    ['Select', 'SelectProps', 'Select', 'field'],
    ['ValidationMessage', 'ValidationMessageProps', 'ValidationMessage', 'field'],
    ['Form.Field', 'FieldProps', 'Field', 'field'],
    ['Form.TextField', 'TextFieldProps', 'TextField', 'field'],
    ['Form.Toggle', 'ToggleProps', 'Toggle', 'field'],
    ['Form.Select', 'SelectProps', 'Select', 'field'],
    ['Form.ValidationMessage', 'ValidationMessageProps', 'ValidationMessage', 'field'],
    ['Form.Actions', 'FormActionsProps', 'FormActions', 'field'],
  ] as const).map(([publicName, propTypeName, symbol, node]) => ({
    publicName,
    propTypeName,
    family: `Form ${publicName}`,
    disposition: 'required' as const,
    proofTier: 'behavior-owning' as const,
    phase: 'graduated' as const,
    publiclyExported: true,
    sharedModule: 'presentation/form/Fields.tsx',
    sharedSymbol: symbol === 'FormActions'
        ? 'HappierFormActions'
        : `Happier${symbol}`,
    pluginOwner: { module: 'components/Form.tsx', symbol },
    coreConsumers: symbol === 'ValidationMessage' || symbol === 'FormActions'
      ? ['components/plugins/surfaces/DeclarativePluginSurface.tsx']
      : [
          'components/sessions/actions/ActionInputFields.tsx',
          'components/plugins/surfaces/DeclarativePluginSurface.tsx',
        ],
    positiveConsumer: {
      kind: 'external-author-reference',
      pathFromRepoRoot: 'packages/plugin-ui/fixtures/external-authoring/src/browser.tsx',
    },
    devMountSymbols: ['Form as PluginForm'],
    declarative: { kind: 'node' as const, node, rendererSymbol: 'context.renderField' },
  })),
  {
    publicName: 'Tabs',
    propTypeName: 'TabsProps',
    family: 'Tabs',
    disposition: 'required',
    proofTier: 'behavior-owning',
    phase: 'graduated',
    publiclyExported: true,
    sharedModule: 'presentation/navigation/Tabs.tsx',
    sharedSymbol: 'resolveHappierTabKeySelection',
    pluginOwner: { module: 'components/Tabs.tsx', symbol: 'TabsRoot' },
    coreConsumers: ['components/ui/navigation/SegmentedTabBar.tsx'],
    positiveConsumer: {
      kind: 'external-author-reference',
      pathFromRepoRoot: 'packages/plugin-ui/fixtures/external-authoring/src/browser.tsx',
    },
    devMountSymbols: ['Tabs as PluginTabs'],
    declarative: { kind: 'not-applicable', reason: 'Preview has no declarative Tabs node without a positive document consumer.' },
  },
  {
    publicName: 'Tabs.Item',
    propTypeName: 'TabsItemProps',
    family: 'Tabs',
    disposition: 'required',
    proofTier: 'behavior-owning',
    phase: 'graduated',
    publiclyExported: true,
    sharedModule: 'presentation/navigation/Tabs.tsx',
    sharedSymbol: 'resolveHappierTabKeySelection',
    pluginOwner: { module: 'components/Tabs.tsx', symbol: 'TabsItem' },
    coreConsumers: ['components/ui/navigation/SegmentedTabBar.tsx'],
    positiveConsumer: {
      kind: 'external-author-reference',
      pathFromRepoRoot: 'packages/plugin-ui/fixtures/external-authoring/src/browser.tsx',
    },
    devMountSymbols: ['Tabs as PluginTabs'],
    declarative: { kind: 'not-applicable', reason: 'Preview has no declarative Tabs node without a positive document consumer.' },
  },
  {
    publicName: 'TargetedSurface',
    propTypeName: 'TargetedSurfaceProps',
    family: 'Targeted embedded surface',
    disposition: 'required',
    // Triage's source-detail region is the maintained consumer: the aggregate
    // owns the common header and lends the exact typed contribution handle plus
    // the published detail-role input to this component, and the source's own
    // renderer mounts beneath it. That closes the author half; graduation still
    // waits on the same packed-platform evidence Progress and BrandMark wait on.
    proofTier: 'behavior-owning',
    phase: 'in-progress',
    publiclyExported: true,
    sharedModule: 'presentationHost/context.ts',
    sharedSymbol: 'useOptionalPluginUiPresentationHost',
    pluginOwner: { module: 'components/TargetedSurface.tsx', symbol: 'TargetedSurface' },
    coreConsumers: [],
    positiveConsumer: {
      kind: 'plugin-surface',
      pathFromRepoRoot: 'packages/plugins/triage/src/ui/detail/region.tsx',
    },
    // A dev-gallery mount would have to invent an admitted contributor,
    // point/protocol epoch and renderer chain; §8.2 forbids crediting this
    // family from a gallery, so the real mount above is the only proof.
    devMountSymbols: [],
    declarative: { kind: 'mounted-node', node: 'targetedSurface', bridgeSymbol: 'renderTargetedSurface' },
    hostComposition: {
      adapter: {
        module: 'components/plugins/surfaces/TargetedPluginSurfaceHost.tsx',
        symbol: 'TargetedPluginSurfaceHost',
      },
      physicalHost: {
        module: 'components/plugins/surfaces/PluginSurfaceHost.tsx',
        symbol: 'PluginSurfaceHost',
        callbackSymbol: 'renderMountedTargetedSurface',
      },
    },
  },
  {
    publicName: 'PluginNavigation',
    propTypeName: 'never',
    family: 'Plugin-local navigation',
    disposition: 'deferred',
    proofTier: 'behavior-owning',
    phase: 'absent',
    publiclyExported: false,
    sharedModule: '(absent)',
    sharedSymbol: '(absent)',
    pluginOwner: { module: '(absent)', symbol: '(absent)' },
    coreConsumers: [],
    devMountSymbols: [],
    declarative: { kind: 'not-applicable', reason: 'Preview defers a plugin-local navigation root.' },
  },
  {
    publicName: 'Dialog',
    propTypeName: 'never',
    family: 'Dialog',
    disposition: 'host-mediated',
    proofTier: 'behavior-owning',
    phase: 'absent',
    publiclyExported: false,
    sharedModule: '(absent)',
    sharedSymbol: '(absent)',
    pluginOwner: { module: '(absent)', symbol: '(absent)' },
    coreConsumers: [],
    devMountSymbols: [],
    declarative: { kind: 'not-applicable', reason: 'The canonical interaction/modal owner mediates dialog outcomes.' },
  },
  ...(['Tooltip', 'Grid', 'Tree', 'Skeleton', 'DiffViewer', 'KeyHint'] as const).map((publicName) => ({
    publicName,
    propTypeName: 'never',
    family: publicName,
    disposition: 'deferred' as const,
    proofTier: 'behavior-owning' as const,
    phase: 'absent' as const,
    publiclyExported: false,
    sharedModule: '(absent)',
    sharedSymbol: '(absent)',
    pluginOwner: { module: '(absent)', symbol: '(absent)' },
    coreConsumers: [],
    devMountSymbols: [],
    declarative: { kind: 'not-applicable' as const, reason: `${publicName} has no accepted Preview consumer.` },
  })),
  ...(['Sheet', 'Drawer'] as const).map((publicName) => ({
    publicName,
    propTypeName: 'never',
    family: publicName,
    disposition: 'host-mediated' as const,
    proofTier: 'behavior-owning' as const,
    phase: 'absent' as const,
    publiclyExported: false,
    sharedModule: '(absent)',
    sharedSymbol: '(absent)',
    pluginOwner: { module: '(absent)', symbol: '(absent)' },
    coreConsumers: [],
    devMountSymbols: [],
    declarative: { kind: 'not-applicable' as const, reason: `${publicName} remains host-owned responsive presentation.` },
  })),
] as const;

const packageSourceRoot = resolve(new URL('.', import.meta.url).pathname);
const repoRoot = resolve(packageSourceRoot, '../../..');
const appSourceRoot = resolve(packageSourceRoot, '../../../apps/ui/sources');
const devMountPath = join(appSourceRoot, 'app/(app)/dev/plugin-ui.tsx');
const declarativeNodeRendererPath = 'components/plugins/shared/declarativeNodes.tsx';
const sourceCache = new Map<string, string>();

function read(filePath: string): string {
  const cached = sourceCache.get(filePath);
  if (cached !== undefined) return cached;
  expect(existsSync(filePath), `${filePath} does not exist`).toBe(true);
  const source = readFileSync(filePath, 'utf8');
  sourceCache.set(filePath, source);
  return source;
}

/**
 * Drop comment prose before auditing for a deleted implementation.
 *
 * An adapter is REQUIRED to name the mechanism it no longer owns — that is how a
 * later reader learns where the behaviour went (§3.10.3). Scanning raw text
 * would turn "this used to carry its own `isPromiseLike`" into a violation, so
 * the audit reads code only. Same rule as `packageBoundary.test.ts`: a prose
 * mention is not an implementation.
 */
function withoutCommentProse(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\*)/u.test(line))
    .join('\n');
}

function sourceForDeclarativeNodeRenderer(source: string, node: string): string | null {
  const sourceWithoutComments = withoutCommentProse(source);
  const rendererTableStart = sourceWithoutComments.indexOf('const DECLARATIVE_NODE_RENDERERS = Object.freeze({');
  if (rendererTableStart < 0) return null;

  const rendererTable = sourceWithoutComments.slice(rendererTableStart);
  const entryPattern = new RegExp(`^ {4}${node}:\\s*`, 'mu');
  const entry = entryPattern.exec(rendererTable);
  if (!entry) return null;

  const nextEntryPattern = /^ {4}[A-Za-z][A-Za-z0-9]*:\s*/gmu;
  nextEntryPattern.lastIndex = entry.index + entry[0].length;
  const nextEntry = nextEntryPattern.exec(rendererTable);
  const entrySource = rendererTable.slice(entry.index, nextEntry?.index);
  const namedRenderer = new RegExp(`^ {4}${node}:\\s*([A-Za-z][A-Za-z0-9]*)\\s*,?\\s*$`, 'mu').exec(entrySource);
  if (!namedRenderer) return entrySource;

  const declarationPattern = new RegExp(`^(?:const|function)\\s+${namedRenderer[1]}\\b`, 'mu');
  const declaration = declarationPattern.exec(sourceWithoutComments);
  return declaration ? sourceWithoutComments.slice(declaration.index, rendererTableStart) : null;
}

function groupByFamily(entries: readonly GraduatedFamily[]): Map<string, readonly GraduatedFamily[]> {
  const groups = new Map<string, GraduatedFamily[]>();
  for (const entry of entries) {
    const current = groups.get(entry.family) ?? [];
    current.push(entry);
    groups.set(entry.family, current);
  }
  return groups;
}

function sourceDeclaresSymbol(source: string, symbol: string): boolean {
  return new RegExp(`(?:export\\s+)?(?:const|function)\\s+${symbol}\\b`, 'u').test(source);
}

function sourceDeclaresExportedType(source: string, typeName: string): boolean {
  return new RegExp(`export\\s+(?:type|interface)\\s+${typeName}\\b`, 'u').test(source);
}

/**
 * A maintained product consumer must import and render the exact public
 * component. Raw source text is not enough: a comment, a sibling component,
 * or a private implementation import can otherwise falsely credit a family.
 */
function sourceRendersPublicPluginUiComponent(source: string, publicName: string): boolean {
  const [rootExport, memberExport] = publicName.split('.');
  if (!rootExport || publicName.split('.').length > 2) return false;
  const sourceFile = ts.createSourceFile(
    `positive-consumer-${publicName}.tsx`,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const importedRoots = new Set<string>();
  const isPublicPluginUiEntry = (specifier: string): boolean => (
    specifier === '@happier-dev/plugin-ui' || specifier === '@happier-dev/plugin-ui/components'
  );

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || !isPublicPluginUiEntry(statement.moduleSpecifier.text)) {
      continue;
    }
    const importClause = statement.importClause;
    if (!importClause || importClause.isTypeOnly) continue;
    const bindings = importClause.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const imported of bindings.elements) {
      if (imported.isTypeOnly) continue;
      const importedName = imported.propertyName?.text ?? imported.name.text;
      if (importedName === rootExport) importedRoots.add(imported.name.text);
    }
  }

  const isExactTag = (tagName: ts.JsxTagNameExpression): boolean => {
    if (memberExport === undefined) {
      return ts.isIdentifier(tagName) && importedRoots.has(tagName.text);
    }
    return ts.isPropertyAccessExpression(tagName)
      && ts.isIdentifier(tagName.expression)
      && importedRoots.has(tagName.expression.text)
      && tagName.name.text === memberExport;
  };

  let rendered = false;
  const visit = (node: ts.Node): void => {
    if (rendered) return;
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && isExactTag(node.tagName)) {
      rendered = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return rendered;
}

function isMaintainedPublicConsumerSource(consumer: PositiveConsumer): boolean {
  if (consumer.kind === 'plugin-surface') {
    return /^packages\/plugins\/[^/]+\/src\/ui\/.+\.(?:ts|tsx)$/u.test(consumer.pathFromRepoRoot);
  }
  return /^packages\/plugin-ui\/fixtures\/external-authoring\/src\/.+\.(?:ts|tsx)$/u
    .test(consumer.pathFromRepoRoot);
}

function catalogProblems(
  entries: readonly GraduatedFamily[],
  sourceFor: (path: string) => string,
): string[] {
  const problems: string[] = [];
  const declarativeNodeRendererSource = read(join(appSourceRoot, declarativeNodeRendererPath));
  const publicEntries = entries.filter((entry) => entry.publiclyExported);
  const publicNames = publicEntries.map((entry) => entry.publicName);
  if (new Set(publicNames).size !== publicNames.length) {
    problems.push('a public presentation export has more than one catalog entry');
  }

  for (const entry of entries) {
    if (entry.disposition === 'required' && !entry.publiclyExported) {
      problems.push(`${entry.publicName} is required but not exported`);
    }
    if (entry.disposition !== 'required' && entry.publiclyExported) {
      problems.push(`${entry.publicName} is ${entry.disposition} but exported`);
    }
    if (entry.publiclyExported && entry.propTypeName === 'never') {
      problems.push(`${entry.publicName} has no exact prop type`);
    }
    if (entry.publiclyExported && entry.phase !== 'absent') {
      const ownerSource = sourceFor(entry.pluginOwner.module);
      if (!sourceDeclaresSymbol(ownerSource, entry.pluginOwner.symbol)) {
        problems.push(`${entry.publicName} does not resolve its declared plugin owner`);
      }
      if (!sourceDeclaresExportedType(ownerSource, entry.propTypeName)) {
        problems.push(`${entry.publicName} does not resolve its declared prop type ${entry.propTypeName}`);
      }
      if (/createElement\(\s*['"][^'"]+['"]/u.test(withoutCommentProse(ownerSource))) {
        problems.push(`${entry.publicName} emits an unregistered native host string`);
      }
    }

    if (entry.phase === 'graduated' && entry.proofTier === 'behavior-owning' && !entry.positiveConsumer) {
      problems.push(`${entry.publicName} has no maintained public product consumer`);
    }
    if (entry.positiveConsumer) {
      if (!isMaintainedPublicConsumerSource(entry.positiveConsumer)) {
        problems.push(`${entry.publicName} positive consumer must be a maintained public plugin or external-author source`);
      }
      if (entry.positiveConsumer.pathFromRepoRoot.includes('/dev/')) {
        problems.push(`${entry.publicName} positive consumer cannot be a dev gallery`);
      }
      const consumerSource = read(join(repoRoot, entry.positiveConsumer.pathFromRepoRoot));
      if (!sourceRendersPublicPluginUiComponent(consumerSource, entry.publicName)) {
        problems.push(`${entry.publicName} positive consumer must render public ${entry.publicName} through a public import`);
      }
    }

    const expectedCoreConsumerSymbol = entry.corePresentationMechanism?.symbol
      ?? entry.coreAdapter?.symbol
      ?? entry.sharedSymbol;
    for (const consumer of entry.coreConsumers) {
      const consumerSource = read(join(appSourceRoot, consumer));
      if (!consumerSource.includes('@happier-dev/plugin-ui/presentation')
        || !consumerSource.includes(expectedCoreConsumerSymbol)) {
        problems.push(`${entry.publicName} core consumer ${consumer} does not reach ${expectedCoreConsumerSymbol}`);
      }
    }
    if (entry.phase === 'graduated' && entry.coreAdapter) {
      const adapter = sourceFor(entry.coreAdapter.module);
      if (!adapter.includes(entry.sharedSymbol)) {
        problems.push(`${entry.publicName} core adapter ${entry.coreAdapter.module} does not consume ${entry.sharedSymbol}`);
      }
    }
    if (entry.phase === 'graduated' && entry.corePresentationMechanism) {
      const mechanism = sourceFor(entry.corePresentationMechanism.module);
      if (!mechanism.includes(entry.corePresentationMechanism.symbol)) {
        problems.push(
          `${entry.publicName} core presentation mechanism ${entry.corePresentationMechanism.module} does not declare ${entry.corePresentationMechanism.symbol}`,
        );
      }
    }

    if (entry.declarative.kind === 'node') {
      const rendererSource = sourceForDeclarativeNodeRenderer(
        declarativeNodeRendererSource,
        entry.declarative.node,
      );
      const reachesRendererSymbol = rendererSource && (
        entry.declarative.rendererSymbol.includes('.')
          ? rendererSource.includes(entry.declarative.rendererSymbol)
          : new RegExp(`\\b${entry.declarative.rendererSymbol}\\b`, 'u').test(rendererSource)
      );
      if (!reachesRendererSymbol) {
        problems.push(`${entry.publicName} declarative node ${entry.declarative.node} does not reach ${entry.declarative.rendererSymbol}`);
      }
    }

    if (entry.declarative.kind === 'mounted-node') {
      if (entry.proofTier !== 'behavior-owning') {
        problems.push(`${entry.publicName} mounted declarative node requires behavior-owning proof`);
      }
      const rendererSource = sourceForDeclarativeNodeRenderer(
        declarativeNodeRendererSource,
        entry.declarative.node,
      );
      if (!rendererSource || !new RegExp(`\\b${entry.declarative.bridgeSymbol}\\b`, 'u').test(rendererSource)) {
        problems.push(`${entry.publicName} mounted declarative node does not reach ${entry.declarative.bridgeSymbol}`);
      }

      const composition = entry.hostComposition;
      if (!composition) {
        problems.push(`${entry.publicName} mounted declarative node has no consumed physical-host path`);
      } else {
        const adapterSource = read(join(appSourceRoot, composition.adapter.module));
        const physicalHostSource = read(join(appSourceRoot, composition.physicalHost.module));
        const callbackStart = physicalHostSource.indexOf(`const ${composition.physicalHost.callbackSymbol}`);
        const callbackEnd = callbackStart < 0
          ? -1
          : physicalHostSource.indexOf('const renderTargetedSurface', callbackStart);
        const callbackSource = callbackStart < 0
          ? ''
          : physicalHostSource.slice(callbackStart, callbackEnd < 0 ? undefined : callbackEnd);

        if (!sourceDeclaresSymbol(adapterSource, composition.adapter.symbol)
          || !adapterSource.includes('props.renderMountedSurface')
          || !sourceDeclaresSymbol(physicalHostSource, composition.physicalHost.symbol)
          || !physicalHostSource.includes(`<${composition.adapter.symbol}`)
          || !physicalHostSource.includes(`renderMountedSurface={${composition.physicalHost.callbackSymbol}}`)
          || !callbackSource.includes(`<${composition.physicalHost.symbol}`)
          || !callbackSource.includes('targetedMount={{')) {
          problems.push(`${entry.publicName} mounted declarative node does not reach the declared physical host`);
        }
      }
    }
  }

  for (const [family, familyEntries] of groupByFamily(entries.filter((entry) => entry.phase === 'graduated'))) {
    const owners = new Set(familyEntries.map((entry) => `${entry.sharedModule}#${entry.sharedSymbol}`));
    if (owners.size !== 1) {
      problems.push(`${family} has more than one shared implementation owner`);
    }
  }

  return problems;
}

function collectPackageSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) return collectPackageSources(entryPath);
    return /\.(?:ts|tsx)$/u.test(entry.name) && !/\.(?:test|spec)\.tsx?$/u.test(entry.name)
      ? [entryPath]
      : [];
  });
}

/**
 * The barrel is the author-visible component boundary. Deriving this small
 * inventory from it prevents a real component being exported without a row in
 * the one presentation catalog above; public hooks are environment/resource
 * API, not component families.
 */
function publicComponentPaths(): readonly string[] {
  const componentIndex = read(join(packageSourceRoot, 'components/index.ts'));
  const modulePaths = [...componentIndex.matchAll(/^export \* from '\.\/([^']+)\.js';$/gmu)]
    .map((match) => match[1])
    .filter((moduleName) => moduleName !== 'PluginUiProvider');

  return modulePaths.flatMap((moduleName) => {
    const source = read(join(packageSourceRoot, 'components', `${moduleName}.tsx`));
    const roots = [...source.matchAll(/^export\s+(?:const|function)\s+([A-Za-z][A-Za-z0-9_]*)\b/gmu)]
      .map((match) => match[1]);
    const namespaceRoots = new Set(
      [...source.matchAll(/export\s+const\s+([A-Za-z][A-Za-z0-9_]*)\s*=\s*Object\.freeze\(/gu)]
        .map((match) => match[1]),
    );
    const compoundMembers = [...source.matchAll(
      /export\s+const\s+([A-Za-z][A-Za-z0-9_]*)\s*=\s*Object\.(?:freeze|assign)\([\s\S]*?\{([\s\S]*?)\}\);/gu,
    )].flatMap((match) => (
      [...match[2].matchAll(/^\s*([A-Za-z][A-Za-z0-9_]*)\s*:/gmu)]
        .map((member) => `${match[1]}.${member[1]}`)
    ));

    return [
      ...roots.filter((root) => !namespaceRoots.has(root) && !root.startsWith('use')),
      ...compoundMembers,
    ];
  });
}

const graduatedEntries = GRADUATED_FAMILIES.filter((entry) => entry.phase === 'graduated');

describe('graduated shared presentation families (§8.2)', () => {
  it('keeps List multi-selection React Context module-local', async () => {
    const source = await read(join(repoRoot, 'packages/plugin-ui/src/components/ListMultiSelection.tsx'));
    expect(source).not.toContain('globalThis');
    expect(source).not.toContain('LIST_MULTI_SELECTION_CONTEXT_GLOBAL_KEY');
  });

  it('resolves the Happier core source tree it audits', () => {
    // Not a skip: an audit that silently passes when it cannot see core would
    // be worse than no audit (§7 forbids silently skipping on a missing input).
    expect(existsSync(appSourceRoot)).toBe(true);
    expect(existsSync(devMountPath)).toBe(true);
  });

  it('is one per-export catalog with an explicit disposition, proof tier and declarative status', () => {
    const problems = catalogProblems(GRADUATED_FAMILIES, (path) => (
      path === '(absent)' ? '' : read(join(packageSourceRoot, path))
    ));

    expect(problems).toEqual([]);
    expect(new Set(GRADUATED_FAMILIES.map((entry) => entry.disposition))).toEqual(new Set([
      'required',
      'deferred',
      'host-mediated',
    ]));
  });

  it('rejects a graduated behavior-owning export when its maintained public consumer is removed', () => {
    const missingTabsConsumer: readonly GraduatedFamily[] = GRADUATED_FAMILIES.map((entry): GraduatedFamily => (
      entry.publicName === 'Tabs'
        ? { ...entry, positiveConsumer: undefined }
        : entry
    ));

    const problems = catalogProblems(missingTabsConsumer, (path) => (
      path === '(absent)' ? '' : read(join(packageSourceRoot, path))
    ));

    expect(problems).toContain('Tabs has no maintained public product consumer');
  });

  it('rejects a declared core mechanism that cannot reach its shared symbol even when a public consumer exists', () => {
    const button = GRADUATED_FAMILIES.find((entry) => entry.publicName === 'Button');
    expect(button?.positiveConsumer).toBeDefined();
    if (!button) return;

    const misboundCoreMechanism = {
      ...button,
      corePresentationMechanism: {
        module: 'presentation/layout/Layout.tsx',
        symbol: 'HappierPressable',
      },
    } satisfies GraduatedFamily;
    const problems = catalogProblems([misboundCoreMechanism], (path) => (
      path === '(absent)' ? '' : read(join(packageSourceRoot, path))
    ));

    expect(problems).toContain(
      'Button core presentation mechanism presentation/layout/Layout.tsx does not declare HappierPressable',
    );
  });

  it('does not let one compound member credit a sibling public symbol', () => {
    const listRootOnlyConsumer = [
      "import { List } from '@happier-dev/plugin-ui';",
      'export function Consumer() { return <List accessibilityLabel="Inventory" />; }',
    ].join('\n');

    expect(sourceRendersPublicPluginUiComponent(listRootOnlyConsumer, 'List')).toBe(true);
    expect(sourceRendersPublicPluginUiComponent(listRootOnlyConsumer, 'List.Section')).toBe(false);
  });

  it('rejects a declarative node mapping that cannot reach its shared owner', () => {
    const wrongTextMapping: readonly GraduatedFamily[] = GRADUATED_FAMILIES.map((entry): GraduatedFamily => (
      entry.publicName === 'Text'
        ? {
            ...entry,
            declarative: { kind: 'node', node: 'metadata', rendererSymbol: 'Text' },
          }
        : entry
    ));

    const problems = catalogProblems(wrongTextMapping, (path) => (
      path === '(absent)' ? '' : read(join(packageSourceRoot, path))
    ));

    // Text's unrelated core consumer is `components/ui/text/Text.tsx`, so this
    // proves declarative ownership cannot disappear behind consumer bookkeeping.
    expect(problems).toContain('Text declarative node metadata does not reach Text');
  });

  it('does not let a maintained public non-Image consumer credit Image', () => {
    const imageCreditedByAnotherPublicSurface: readonly GraduatedFamily[] = GRADUATED_FAMILIES.map((entry): GraduatedFamily => (
      entry.publicName === 'Image'
        ? {
            ...entry,
            phase: 'graduated',
            positiveConsumer: {
              kind: 'external-author-reference',
              pathFromRepoRoot: 'packages/plugin-ui/fixtures/external-authoring/src/Surface.tsx',
            },
          }
        : entry
    ));

    const problems = catalogProblems(imageCreditedByAnotherPublicSurface, (path) => (
      path === '(absent)' ? '' : read(join(packageSourceRoot, path))
    ));

    expect(problems).toContain('Image positive consumer must render public Image through a public import');
  });

  it('records Inspector generic Image adoption without claiming graduation', () => {
    const image = GRADUATED_FAMILIES.find((entry) => entry.publicName === 'Image');

    expect(image).toMatchObject({
      phase: 'in-progress',
      coreConsumers: [],
      positiveConsumer: {
        kind: 'plugin-surface',
        pathFromRepoRoot: 'packages/plugins/inspector/src/ui/renderSurface.tsx',
      },
    });
  });

  it('records BrandMark source adoption while retaining its packed-platform graduation requirement', () => {
    const brandMark = GRADUATED_FAMILIES.find((entry) => entry.publicName === 'BrandMark');

    expect(brandMark).toMatchObject({
      phase: 'in-progress',
      coreConsumers: [
        'components/plugins/permissions/PluginPermissionGrantSheet.tsx',
        'components/plugins/shared/InstalledPluginBrandMark.tsx',
      ],
      positiveConsumer: {
        kind: 'plugin-surface',
        pathFromRepoRoot: 'packages/plugins/inspector/src/ui/renderSurface.tsx',
      },
    });
  });

  it('does not let the dev gallery satisfy an in-progress family\'s product-consumer proof', () => {
    const imageCreditedByDevGallery: readonly GraduatedFamily[] = GRADUATED_FAMILIES.map((entry): GraduatedFamily => (
      entry.publicName === 'Image'
        ? {
            ...entry,
            phase: 'graduated',
            positiveConsumer: {
              kind: 'plugin-surface',
              pathFromRepoRoot: 'apps/ui/sources/app/(app)/dev/plugin-ui.tsx',
            },
          }
        : entry
    ));

    const problems = catalogProblems(imageCreditedByDevGallery, (path) => (
      path === '(absent)' ? '' : read(join(packageSourceRoot, path))
    ));

    expect(problems).toContain('Image positive consumer cannot be a dev gallery');
  });

  it('does not let a generated Progress artifact stand in for a maintained public consumer', () => {
    const progressCreditedByGeneratedArtifact: readonly GraduatedFamily[] = GRADUATED_FAMILIES.map((entry): GraduatedFamily => (
      entry.publicName === 'Progress'
        ? {
            ...entry,
            phase: 'graduated',
            positiveConsumer: {
              kind: 'plugin-surface',
              pathFromRepoRoot: 'packages/plugins/inspector/dist/ui/renderSurface.js',
            },
          }
        : entry
    ));

    const problems = catalogProblems(progressCreditedByGeneratedArtifact, (path) => (
      path === '(absent)' ? '' : read(join(packageSourceRoot, path))
    ));

    expect(problems).toContain('Progress positive consumer must be a maintained public plugin or external-author source');
  });

  it('requires a runtime named public import before crediting Progress', () => {
    const genericFamilyImport = [
      "import * as PluginUi from '@happier-dev/plugin-ui';",
      'export function Consumer() { return <PluginUi.Progress label="Refreshing" />; }',
    ].join('\n');
    const typeOnlyImport = [
      "import type { Progress } from '@happier-dev/plugin-ui';",
      'export function Consumer() { return <Progress label="Refreshing" />; }',
    ].join('\n');

    expect(sourceRendersPublicPluginUiComponent(genericFamilyImport, 'Progress')).toBe(false);
    expect(sourceRendersPublicPluginUiComponent(typeOnlyImport, 'Progress')).toBe(false);
  });

  it('lists each required public source API held short of product graduation', () => {
    const unfinished = GRADUATED_FAMILIES
      .filter((entry) => entry.disposition === 'required' && entry.publiclyExported && entry.phase !== 'graduated')
      .map((entry) => entry.publicName);

    expect(unfinished).toEqual([
      'createListMultiSelectionStore',
      'ListMultiSelectionProvider',
      'ListSelectionActionBar',
      'List.SelectionActionBar',
      'Progress',
      'Image',
      'BrandMark',
      'TargetedSurface',
    ]);
  });

  it('records the current app surface adoption that graduates Screen', () => {
    const screen = GRADUATED_FAMILIES.find((entry) => entry.publicName === 'Screen');

    expect(screen).toMatchObject({
      phase: 'graduated',
      coreConsumers: ['components/plugins/surfaces/DeclarativePluginSurface.tsx'],
    });
    expect(read(join(appSourceRoot, 'components/plugins/surfaces/DeclarativePluginSurface.tsx')))
      .toContain('<HappierScreen');
  });

  it('records Progress source evidence while retaining its packed-platform graduation requirement', () => {
    const progress = GRADUATED_FAMILIES.find((entry) => entry.publicName === 'Progress');

    expect(progress).toMatchObject({
      phase: 'in-progress',
      coreConsumers: ['components/browser/BrowserLoadProgressBar.tsx'],
      positiveConsumer: {
        kind: 'plugin-surface',
        pathFromRepoRoot: 'packages/plugins/inspector/src/ui/renderSurface.tsx',
      },
    });
    expect(read(join(appSourceRoot, 'components/browser/BrowserLoadProgressBar.tsx')))
      .toContain('<HappierProgress');
    expect(sourceRendersPublicPluginUiComponent(
      read(join(repoRoot, 'packages/plugins/inspector/src/ui/renderSurface.tsx')),
      'Progress',
    )).toBe(true);
  });

  it('records the Triage source-detail adoption that gives TargetedSurface its maintained consumer', () => {
    const targetedSurface = GRADUATED_FAMILIES.find((entry) => entry.publicName === 'TargetedSurface');

    expect(targetedSurface).toMatchObject({
      disposition: 'required',
      publiclyExported: true,
      // Still short of graduation for the same reason Progress and BrandMark
      // are: packed-platform evidence is owned by 03g. The consumer half is no
      // longer the gap.
      phase: 'in-progress',
      positiveConsumer: {
        kind: 'plugin-surface',
        pathFromRepoRoot: 'packages/plugins/triage/src/ui/detail/region.tsx',
      },
    });
    // The deciding half. The catalog row alone would keep passing if Triage
    // stopped mounting the source's own detail body and went back to rendering
    // its own facts, which is exactly the state this family was stuck in.
    expect(sourceRendersPublicPluginUiComponent(
      read(join(repoRoot, 'packages/plugins/triage/src/ui/detail/region.tsx')),
      'TargetedSurface',
    )).toBe(true);
  });

  it('records Triage bulk source adoption for List.SelectionActionBar', () => {
    const actionBar = GRADUATED_FAMILIES.find((entry) => entry.publicName === 'List.SelectionActionBar');

    expect(actionBar).toMatchObject({
      disposition: 'required',
      publiclyExported: true,
      phase: 'in-progress',
      positiveConsumer: {
        kind: 'plugin-surface',
        pathFromRepoRoot: 'packages/plugins/triage/src/ui/list/BulkActionBar.tsx',
      },
    });
    expect(sourceRendersPublicPluginUiComponent(
      read(join(repoRoot, 'packages/plugins/triage/src/ui/list/BulkActionBar.tsx')),
      'List.SelectionActionBar',
    )).toBe(true);
  });

  it('proves the public Action Form lifecycle through an external author consumer', () => {
    const form = GRADUATED_FAMILIES.find((entry) => entry.publicName === 'Form');
    expect(form?.positiveConsumer).toEqual({
      kind: 'external-author-reference',
      pathFromRepoRoot: 'packages/plugin-ui/fixtures/external-authoring/src/Surface.tsx',
    });
  });

  it('keeps every public overlay in the controlled external-author fixture', () => {
    const source = read(join(repoRoot, 'packages/plugin-ui/fixtures/external-authoring/src/Surface.tsx'));
    for (const [component, state] of [
      ['Popover', 'popover'],
      ['Menu', 'menu'],
      ['Dropdown', 'dropdown'],
      ['ContextMenu', 'contextMenu'],
    ] as const) {
      expect(source, `${component} must be imported by an out-of-package author`).toMatch(
        new RegExp(`\\b${component}\\b`, 'u'),
      );
      expect(source, `${component} must be rendered by an out-of-package author`).toContain(`<${component}`);
      expect(source, `${component} must retain author-controlled open state`).toContain(`open={${state}Open}`);
      expect(source, `${component} must publish its close/open requests to the author`).toContain(
        `onOpenChange={set${component}Open}`,
      );
    }
    expect(source).not.toContain('presentationHost');
    expect(source).not.toContain('renderPopover');
  });

  it('catalogs every public component and compound member from the author barrel', () => {
    const catalogedComponents = new Set(
      GRADUATED_FAMILIES
        .filter((entry) => entry.publiclyExported)
        .map((entry) => entry.publicName),
    );

    expect([...catalogedComponents].sort()).toEqual([...publicComponentPaths()].sort());
  });

  it('matches the approved §6 vocabulary rather than deriving expected families from the barrel', () => {
    expect(GRADUATED_FAMILIES.map((entry) => entry.publicName).sort())
      .toEqual([...APPROVED_CATALOG_VOCABULARY].sort());
  });

  it('has one shared implementation per graduated family and both real adapters', () => {
    for (const [family, entries] of groupByFamily(graduatedEntries)) {
      const owners = new Set(entries.map((entry) => `${entry.sharedModule}#${entry.sharedSymbol}`));
      expect(owners.size, `${family} has more than one shared owner`).toBe(1);
    }

    for (const entry of graduatedEntries) {
      const shared = read(join(packageSourceRoot, entry.sharedModule));
      expect(shared, `${entry.sharedModule} must export ${entry.sharedSymbol}`)
        .toMatch(new RegExp(`export\\s+(?:const|function)\\s+${entry.sharedSymbol}\\b`, 'u'));

      expect(
        entry.coreConsumers.length + (entry.hostComposition ? 1 : 0),
        `${entry.family} has no core consumer or consumed physical-host path`,
      ).toBeGreaterThan(0);

      for (const consumer of entry.coreConsumers) {
        expect(consumer, `${entry.family} cannot graduate through a dev-only gallery`).not.toContain('/dev/');
        expect(consumer, `${entry.family} cannot graduate through the private surface carrier`).not.toContain('PluginSurfaceHost');
        const source = read(join(appSourceRoot, consumer));
        expect(source, `${consumer} must reach the shared presentation owner`)
          .toContain('@happier-dev/plugin-ui/presentation');
        const expectedConsumerSymbol = entry.corePresentationMechanism?.symbol ?? entry.coreAdapter?.symbol ?? entry.sharedSymbol;
        expect(source, `${consumer} must consume ${expectedConsumerSymbol}, not merely import the presentation barrel`)
          .toContain(expectedConsumerSymbol);
        if (entry.coreAdapter) {
          const adapter = read(join(packageSourceRoot, entry.coreAdapter.module));
          expect(adapter, `${entry.coreAdapter.module} must consume ${entry.sharedSymbol}`)
            .toContain(entry.sharedSymbol);
        }
        if (entry.corePresentationMechanism) {
          const mechanism = read(join(packageSourceRoot, entry.corePresentationMechanism.module));
          expect(mechanism, `${entry.corePresentationMechanism.module} must declare ${entry.corePresentationMechanism.symbol}`)
            .toContain(entry.corePresentationMechanism.symbol);
        }
      }

      if (entry.positiveConsumer) {
        const source = read(join(repoRoot, entry.positiveConsumer.pathFromRepoRoot));
        expect(
          sourceRendersPublicPluginUiComponent(source, entry.publicName),
          `${entry.publicName} lacks an exact public production consumer`,
        ).toBe(true);
      }

      const pluginSource = read(join(packageSourceRoot, entry.pluginOwner.module));
      const consumesSharedPresentation = /from '\.\.\/presentation\//u.test(pluginSource)
        || /from '\.\.\/presentationHost\/context\.js'/u.test(pluginSource)
        // Action members intentionally compose the one public Button adapter;
        // Button is the direct HappierPressable adapter. Re-importing the
        // pressable in Action would create two chrome/pending paths.
        || (entry.sharedSymbol === 'HappierPressable' && /from '\.\/Button\.js'/u.test(pluginSource));
      expect(consumesSharedPresentation, `${entry.publicName} must render its shared presentation owner`).toBe(true);
    }
  });

  it('keeps the real Popover placement algorithm shared instead of retaining a core-local resolver', () => {
    expect(resolveHappierPopoverPlacement({
      placement: 'auto-horizontal',
      preferredMinAvailable: 240,
      available: { top: 100, bottom: 100, left: 320, right: 24 },
    })).toBe('left');

    const corePopover = read(join(appSourceRoot, 'components/ui/popover/Popover.tsx'));
    expect(corePopover).toContain('resolveHappierPopoverPlacement({');
    expect(corePopover).not.toContain("from './positioning'");
    expect(existsSync(join(appSourceRoot, 'components/ui/popover/positioning.ts'))).toBe(false);
  });

  it('renders every graduated family from the existing dev demo-surface owner', () => {
    const devMount = read(devMountPath);
    for (const entry of graduatedEntries) {
      for (const symbol of entry.devMountSymbols) {
        expect(devMount, `${entry.family} is not mounted at dev/plugin-ui`).toContain(symbol);
      }
    }
  });

  it('keeps the dev overlay examples controlled and reachable instead of permanently inert', () => {
    const devMount = read(devMountPath);
    for (const overlay of ['Menu', 'Dropdown', 'ContextMenu'] as const) {
      expect(devMount).toContain(`const [${overlay[0].toLowerCase()}${overlay.slice(1)}Open, set${overlay}Open]`);
      expect(devMount).toContain(`<Plugin${overlay}\n                        open={${overlay[0].toLowerCase()}${overlay.slice(1)}Open}`);
      expect(devMount).toContain(`onOpenChange={set${overlay}Open}`);
    }
    expect(devMount).not.toContain('open={false}');
    expect(devMount).not.toContain('onOpenChange={() => undefined}');
  });

  it('keeps every listed marker predecessor deleted and no production marker emission reachable', () => {
    const deletedPaths = new Set(graduatedEntries.flatMap((entry) => entry.deletedPackagePaths ?? []));
    for (const path of deletedPaths) {
      expect(existsSync(join(packageSourceRoot, path)), `${path} must be deleted with its replacement`).toBe(false);
    }

    const markers = collectPackageSources(packageSourceRoot)
      .filter((path) => /happier-plugin-[a-z0-9-]+/u.test(withoutCommentProse(read(path))))
      .map((path) => path.slice(packageSourceRoot.length + 1));
    expect(markers).toEqual([]);
  });

  it('leaves no Happier core module implementing a cataloged mechanism locally', () => {
    // Every family whose shared owner is real, not only the graduated ones: an
    // in-progress family that has already replaced a core-local implementation
    // must not silently regain one while it waits for its public consumer.
    const survivors = GRADUATED_FAMILIES
      .filter((entry) => entry.phase !== 'absent')
      .flatMap((entry) => (
        (entry.deletedCoreDuplicates ?? [])
          .filter((duplicate) => (
            new RegExp(`\\b${duplicate.symbol}\\b`, 'u')
              .test(withoutCommentProse(read(join(appSourceRoot, duplicate.path))))
          ))
          .map((duplicate) => `${duplicate.path} still implements ${entry.family} locally (${duplicate.symbol})`)
      ));

    expect(survivors).toEqual([]);
  });

  it('renders the cataloged core Link through HappierLink instead of a local pressable path', () => {
    const source = withoutCommentProse(
      read(join(appSourceRoot, 'components/settings/providers/ProviderExternalLinkItem.tsx')),
    );

    // An import alone would make the general catalog guard pass while retaining
    // a separate focus/pending/link-accessibility owner in this core consumer.
    expect(source).toContain('<HappierLink');
    expect(source).not.toMatch(/<Pressable\b/u);
  });

  it('would reject an exported unregistered native host string in a fixture', () => {
    const fixture = {
      ...GRADUATED_FAMILIES[0],
      publicName: 'MarkerFixture',
      propTypeName: 'MarkerFixtureProps',
      family: 'MarkerFixture',
      sharedModule: 'presentation/fixture/Marker.tsx',
      sharedSymbol: 'HappierMarkerFixture',
      pluginOwner: { module: 'components/MarkerFixture.tsx', symbol: 'MarkerFixture' },
      coreConsumers: [],
      devMountSymbols: [],
      phase: 'in-progress' as const,
    } satisfies GraduatedFamily;

    const problems = catalogProblems([fixture], (path) => (
      path === 'components/MarkerFixture.tsx'
        ? "export type MarkerFixtureProps = {}; export function MarkerFixture() { return createElement('unregistered-view'); }"
        : ''
    ));

    expect(problems).toContain('MarkerFixture emits an unregistered native host string');
  });

  it('would reject a catalog row whose exact public prop type is not exported by its owner', () => {
    const [surface] = GRADUATED_FAMILIES.filter((entry) => entry.publicName === 'Surface');
    const fixture = {
      ...surface,
      propTypeName: 'MissingSurfaceProps',
    } satisfies GraduatedFamily;

    const problems = catalogProblems([fixture], () => 'export type SurfaceProps = {}; export function Surface() {}');

    expect(problems).toContain('Surface does not resolve its declared prop type MissingSurfaceProps');
  });

  it('would reject a duplicate shared implementation owner in a fixture', () => {
    const [surface] = GRADUATED_FAMILIES.filter((entry) => entry.publicName === 'Surface');
    const duplicate = {
      ...surface,
      publicName: 'SurfaceDuplicate',
      propTypeName: 'SurfaceDuplicateProps',
      sharedModule: 'presentation/layout/SecondSurface.tsx',
      sharedSymbol: 'HappierSecondSurface',
      pluginOwner: { module: 'components/SecondSurface.tsx', symbol: 'SecondSurface' },
    } satisfies GraduatedFamily;

    const problems = catalogProblems([surface, duplicate], () => 'export function SecondSurface() {}');
    expect(problems).toContain('Surface has more than one shared implementation owner');
  });

  it('rejects a catalog-only mounted surface row without a real host consumer or its behavior-owning proof tier', () => {
    const [surface] = GRADUATED_FAMILIES.filter((entry) => entry.publicName === 'Surface');
    const catalogOnlyTargetedSurface = {
      ...surface,
      publicName: 'TargetedSurface',
      propTypeName: 'TargetedSurfaceProps',
      family: 'Targeted embedded surface',
      proofTier: 'simple',
      sharedModule: 'presentationHost/context.ts',
      sharedSymbol: 'useOptionalPluginUiPresentationHost',
      pluginOwner: { module: 'components/TargetedSurface.tsx', symbol: 'TargetedSurface' },
      coreConsumers: [],
      devMountSymbols: [],
      declarative: { kind: 'mounted-node', node: 'targetedSurface', bridgeSymbol: 'renderTargetedSurface' },
    } satisfies GraduatedFamily;

    const problems = catalogProblems([catalogOnlyTargetedSurface], (path) => (
      read(join(packageSourceRoot, path))
    ));

    expect(problems).toContain('TargetedSurface mounted declarative node has no consumed physical-host path');
    expect(problems).toContain('TargetedSurface mounted declarative node requires behavior-owning proof');
  });
});
