/**
 * The shared presentation layer (§3.10).
 *
 * Everything here depends on React, React Native and the `HappierUiEnvironment`
 * seam — nothing else. It is consumed by BOTH Happier core adapters
 * (`apps/ui/sources/components/**`) and the plugin adapters in this package, so
 * a semantic control has exactly one implementation (UI-T27).
 *
 * Layering (§3.10.1.1, enforced by `packageBoundary.test.ts`):
 *   presentation → React/RN + environment only
 *   adapters     → presentation + plugin-sdk/ui
 */
export type { HappierLayoutChangeEvent, HappierTextSelection } from './portableTypes.js';
export {
  HappierText,
  HappierTextSelectabilityScope,
  useHappierTextPresentation,
  type HappierTextProps,
  type HappierTextPresentation,
  type HappierTextPresentationInput,
  type HappierTextSelectabilityScopeProps,
} from './text/Text.js';
export {
  HAPPIER_TONE_COLOR_TOKEN,
  type HappierTextVariant,
  type HappierTone,
} from './semantics.js';
export {
  cloneStyleEntryPreservingOwnProps,
  scaleTextStyleMetrics,
  type ScaleTextStyleOptions,
  type ScaledTextStyleMetrics,
  type TextStyleEntryTransform,
} from './text/textStyleScale.js';
export {
  HappierSpinner,
  iconMatchedSpinnerSize,
  resolveHappierWebSpinnerPresentation,
  type HappierWebSpinnerPresentation,
  type HappierWebSpinnerPresentationInput,
  type HappierWebSpinnerStyle,
  type HappierSpinnerProps,
} from './feedback/Spinner.js';
export {
  HappierStatusDot,
  type HappierStatusDotProps,
} from './status/StatusDot.js';
export {
  HappierStatus,
  type HappierStatusProps,
} from './status/Status.js';
export {
  HappierActionPanel,
  HappierActionPanelSection,
  type HappierActionPanelProps,
  type HappierActionPanelSectionProps,
} from './interaction/ActionPanel.js';
export {
  HappierPressable,
  type HappierPressableProps,
  type HappierPressableRole,
  type HappierPressableState,
  type HappierPressableStyleState,
} from './interaction/Pressable.js';
export {
  resolveHappierMenuKeyAction,
  resolveHappierMenuContent,
  resolveHappierMenuRadioGroups,
  resolveHappierMenuSelection,
  resolveHappierMenuTypeahead,
  useHappierMenuInteraction,
  matchesHappierMenuQuery,
  resolveHappierPopoverPlacement,
  type HappierMenuItemDescriptor,
  type HappierMenuContent,
  type HappierMenuEntry,
  type HappierMenuGroupDescriptor,
  type HappierMenuInteractionInput,
  type HappierMenuKeyAction,
  type HappierMenuRadioGroupDescriptor,
  type HappierPopoverPlacement,
  type HappierResolvedPopoverPlacement,
  type HappierResolvedMenuGroup,
} from './interaction/Menu.js';
export {
  HappierInfoState,
  HappierInfoTile,
  type HappierInfoStateProps,
  type HappierInfoTileProps,
} from './state/InfoState.js';
export {
  HappierList,
  HappierListItem,
  HappierListSection,
  type HappierListItemProps,
  type HappierListProps,
  type HappierListSectionProps,
} from './collection/List.js';
export {
  HappierItemGroupBehavior,
  HappierItemGroupSelectionContext,
  HappierItemGroup,
  useHappierItemGroupItemBehavior,
  type HappierItemGroupBehaviorProps,
  type HappierItemGroupItemBehaviorInput,
  type HappierItemGroupProps,
  type HappierItemGroupRadioFocusable,
} from './collection/ItemGroup.js';
export {
  HappierItemOverflow,
  type HappierItemOverflowAction,
  type HappierItemOverflowProps,
  type HappierItemOverflowRenderInput,
} from './collection/ItemOverflow.js';
export {
  resolveHappierItemBehavior,
  resolveHappierItemGroupConstraints,
  resolveHappierItemSemantics,
  resolveHappierRovingSelection,
  type HappierItemSemanticInput,
  type HappierItemBehavior,
  type HappierItemBehaviorInput,
  type HappierItemDensity,
  type HappierItemSemanticState,
  type HappierRovingEntry,
  type HappierSelectableRole,
} from './collection/semantics.js';
/**
 * The one keyed multi-selection state machine and its subscribable store.
 *
 * Exported here — beside the collection semantics rather than from the author
 * component layer — because `apps/ui`'s sessions list binds it with its own list
 * implementation and must not pull the plugin component barrel to do so.
 */
export {
  HAPPIER_LIST_MULTI_SELECTION_INERT_ROW_SNAPSHOT,
  HAPPIER_LIST_MULTI_SELECTION_INERT_SNAPSHOT,
  createHappierListMultiSelectionStore,
  createInitialHappierListMultiSelectionState,
  parseHappierListMultiSelectionRowSnapshot,
  readHappierPointerModifiers,
  reduceHappierListMultiSelection,
  resolveHappierListMultiSelectionKeyboardIntent,
  resolveHappierListMultiSelectionPointerAction,
  resolveHappierListMultiSelectionRange,
  resolveHappierPointerPlatform,
  toHappierListMultiSelectionSnapshot,
  type CreateHappierListMultiSelectionStateInput,
  type HappierListMultiSelectionAction,
  type HappierListMultiSelectionActions,
  type HappierListMultiSelectionKey,
  type HappierListMultiSelectionKeyboardInput,
  type HappierListMultiSelectionKeyboardIntent,
  type HappierListMultiSelectionPointerAction,
  type HappierListMultiSelectionPointerInput,
  type HappierListMultiSelectionRangeInput,
  type HappierListMultiSelectionRowFlags,
  type HappierListMultiSelectionRowsInput,
  type HappierListMultiSelectionSnapshot,
  type HappierListMultiSelectionState,
  type HappierListMultiSelectionStore,
  type HappierPointerModifiers,
  type HappierPointerPlatform,
} from './collection/multiSelection.js';
export {
  HappierSurface,
  type HappierSurfaceProps,
} from './layout/Surface.js';
export {
  HappierScreen,
  HappierScrollArea,
  HappierStack,
  resolveHappierLayoutGap,
  type HappierLayoutGap,
  type HappierLayoutSpacing,
  type HappierScreenProps,
  type HappierScrollAreaProps,
  type HappierStackProps,
} from './layout/Layout.js';
export {
  HappierBadge,
  HappierBanner,
  HappierDivider,
  HappierHeading,
  HappierLabel,
  HappierLink,
  HappierMetadata,
  HappierProgress,
  isHappierBannerUrgent,
  resolveHappierProgressPercentage,
  type HappierMetadataEntry,
} from './content/Foundation.js';
export {
  HappierMarkdown,
  type HappierMarkdownProps,
  type HappierMarkdownRenderInput,
} from './content/Markdown.js';
export {
  normalizeHappierCodeLanguage,
  resolveHappierCodeBlockLayout,
  useHappierCodeBlockBehavior,
  type HappierCodeBlockBehaviorInput,
} from './content/CodeBlock.js';
export {
  HAPPIER_ICON_NAMES,
  isHappierIconName,
  resolveHappierIconSize,
  type HappierIconName,
  type HappierIconSize,
} from './content/Icon.js';
export {
  HappierBrandMark,
  resolveHappierBrandFallback,
  resolveHappierImagePixels,
  type HappierBrandMarkProps,
  type HappierImageSize,
} from './content/Image.js';
export {
  HappierField,
  HappierForm,
  HappierFormActions,
  HappierSelect,
  HappierTextField,
  HappierToggle,
  HappierValidationMessage,
  resolveHappierFormPending,
  useHappierFormSubmission,
  type HappierFieldProps,
  type HappierFormActionsProps,
  type HappierFormPendingInput,
  type HappierFormProps,
  type HappierSelectOption,
  type HappierTextFieldProps,
  type HappierValidationMessageProps,
} from './form/Fields.js';
export {
  patchHappierActionInputPath,
  readHappierActionInputPath,
  resolveHappierActionFieldPresentation,
  writeHappierActionInputPath,
  type HappierActionFieldPresentation,
} from './form/actionInputFields.js';
export {
  HappierTabs,
  isHappierTabSelected,
  resolveHappierTabKeySelection,
  useHappierTabPanelActivity,
  type HappierTabDescriptor,
  type HappierTabPanelActivity,
  type HappierTabRetention,
} from './navigation/Tabs.js';
