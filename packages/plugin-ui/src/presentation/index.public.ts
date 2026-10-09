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
export type {
  HappierLayoutChangeEvent,
  HappierTextSelection,
} from './portableTypes.js';
export * from './interaction/companionReleaseMotion.js';
export * from './interaction/companionPointerDragConfig.js';
export * from './interaction/resolveCompanionDragVelocity.js';
export * from './interaction/companionGeometry.js';
export * from './interaction/useCompanionPointerDragSession.js';
export {
  frameRectsOverlap,
  resolveFloatingFrameRect,
  type FrameRect,
  type FloatingFrameMode,
  type FloatingFrameGeometry,
} from './layout/floatingFrameGeometry.js';
export {
  FloatingFrame,
  HAPPIER_FLOATING_FRAME_METRICS,
  resolveFloatingFrameBodyRect,
  resolveFloatingFrameCorner,
  resolveFloatingFrameCornerRect,
  resolveFloatingFrameHeight,
  type FloatingFrameCorner,
  type FloatingFrameProps,
  type FloatingFrameRectChange,
  type HappierFloatingFramePointerBinding,
} from './layout/FloatingFrame.js';
export {
  useHappierTreeInteraction,
  resolveHappierTreeFocusKey,
  resolveHappierTreeKeyIntent,
  type HappierTreeNode,
  type HappierTreeInteraction,
  type HappierTreeKeyIntent,
} from './navigation/treeInteraction.js';
export {
  HAPPIER_TREE_ROW_METRICS,
  HappierTreeDisclosure,
  resolveHappierTreeRowIndentPx,
} from './navigation/TreeRow.js';
export {
  WidgetSizePicker,
  type WidgetSizePickerProps,
  type WidgetSizePickerChoice,
  type WidgetSizePickerCompactInput,
} from './layout/WidgetSizePicker.js';
export type {
  CollectionVirtualizer,
  CollectionVirtualizerHandle,
  CollectionVirtualizerRequest,
} from './collection/collectionVirtualizer.js';
export { HappierDropTargetOutline } from './interaction/DropTargetOutline.js';
export {
  HappierArtifactPreviewCard,
  type HappierArtifactPreview,
  type HappierArtifactPreviewCardProps,
  type HappierArtifactPreviewCardHost,
} from './artifacts/ArtifactPreviewCard.js';
export {
  HappierHtmlSandboxFrame,
  type HappierHtmlSandboxFrameProps,
  type HappierHtmlSandboxFrameHost,
} from './artifacts/HtmlSandboxFrame.js';
export {
  HappierPublicLinkCard,
  type HappierPublicLinkCardProps,
} from './artifacts/PublicLinkCard.js';
export {
  HappierArtifactRevisionList,
  type HappierArtifactRevisionListProps,
  type HappierArtifactRevisionRow,
} from './artifacts/ArtifactRevisionList.js';
export {
  HappierSetupSteps,
  type HappierSetupStep,
  type HappierSetupStepsProps,
} from './content/SetupSteps.js';
export { HappierFieldStepper } from './form/FieldStepper.js';
export type { HappierFieldStepperBounds } from './form/fieldValueDraft.js';
export {
  happierMaterialBackgroundColor,
  type HappierMaterialRole,
} from './layout/material.js';
export {
  matchFindText,
  type FindTextMatchRange,
  type FindTextMatchResult,
} from './find/matchFindText.js';
export {
  HappierStoredImage,
  type HappierStoredImageProps,
  type HappierStoredImageHost,
} from './content/StoredImage.js';
export {
  resolveHappierStoredImageDimensions,
  resolveHappierStoredImageLayout,
  type HappierStoredImageDimensions,
} from './content/storedImageLayout.js';
export { HappierLiveStreamInputLayer } from './media/LiveStreamInputLayer.js';
export {
  HappierLiveStream,
  type HappierLiveStreamProps,
} from './media/LiveStream.js';
export { HappierLiveStreamPlayer } from './media/LiveStreamPlayer.js';
export type {
  HappierLiveStreamPlayerHost,
  HappierLiveStreamPlayerDisplayState,
  HappierLiveStreamAvccInput,
  HappierLiveStreamPlayerRendererEvent,
  HappierLiveStreamPlayerDiagnostic,
  HappierLiveStreamPlayerRenderEvent,
} from './media/liveStreamPlayerTypes.js';
export type {
  HappierLiveStreamInputGesture,
  HappierLiveStreamGestureGeometry,
  HappierLiveStreamPoint,
  HappierLiveStreamInputControlKind,
  HappierLiveStreamOrientation,
  HappierLiveStreamRect,
} from './media/inputGesture.js';
export {
  HAPPIER_ICON_BUTTON_SIZE,
  resolveHappierIconButtonChrome,
} from './interaction/iconButtonChrome.js';
export {
  HappierListDetailLayout,
  type HappierListDetailLayoutProps,
  type HappierListDetailLayoutState,
} from './collection/ListDetailLayout.js';
export {
  useHappierCollectionIndexView,
  useHappierCollectionLayout,
  type HappierCollectionIndexView,
  type HappierCollectionLayoutMode,
  type HappierCollectionLayoutState,
} from './collection/collectionLayout.js';
export {
  HAPPIER_COLLECTION_WINDOW_COMPLETE,
  createHappierCollectionDraftTitleStore,
  createHappierCollectionVisitMemory,
  resolveHappierCollectionInitialKey,
  type HappierCollectionDraftTitleStore,
  type HappierCollectionGroup,
  type HappierCollectionGrouping,
  type HappierCollectionKey,
  type HappierCollectionSection,
  type HappierCollectionVisitMemory,
  type HappierCollectionWindow,
} from './collection/collectionModel.js';
export {
  useHappierCollection,
  useHappierCollectionVisit,
  type HappierCollectionActions,
  type HappierCollectionDraft,
  type HappierCollectionDraftInput,
  type HappierCollectionModel,
  type HappierCollectionModelInput,
  type HappierCollectionViewport,
} from './collection/useCollection.js';
export {
  HAPPIER_COLLECTION_LIST_METRICS,
  HAPPIER_COLLECTION_LIST_ROW_STYLE,
  HAPPIER_COLLECTION_LIST_TEXT,
  resolveHappierCollectionListRowPadding,
  HappierCollectionList,
  HappierCollectionListGroupLabel,
  HappierCollectionListMark,
  useHappierCollectionDraftRowTitle,
  type HappierCollectionListFilters,
  type HappierCollectionListHost,
  type HappierCollectionListProps,
  type HappierCollectionListSearch,
  type HappierCollectionListTextRole,
} from './collection/CollectionList.js';
export {
  HAPPIER_COLLECTION_DETAIL_SLIDE,
  HAPPIER_COLLECTION_REDUCED_MOTION_TRACKS,
  HAPPIER_COLLECTION_TRANSITION_TIMELINE,
  HAPPIER_COLLECTION_TRANSITION_TRACKS,
  evaluateHappierCollectionMotionTrack,
  happierCollectionTravelTrack,
  planHappierCollectionTransitionOffsets,
  resolveHappierCollectionComposition,
  resolveHappierCollectionTableColumns,
  resolveHappierCollectionTransitionPhase,
  type HappierCollectionComposition,
  type HappierCollectionDetailContainer,
  type HappierCollectionMotionTrack,
  type HappierCollectionMotionTracks,
  type HappierCollectionPresentation,
  type HappierCollectionTableColumn,
  type HappierCollectionTransitionCell,
  type HappierCollectionTransitionEasing,
  type HappierCollectionTransitionPlan,
} from './collection/collectionTable.js';
export {
  HAPPIER_COLLECTION_INSTANT_MOTION,
  HAPPIER_INSTANT_DISCLOSURE_MOTION,
  resolveHappierCollectionTrackStyle,
  type HappierCollectionAnimatedViewProps,
  type HappierCollectionMotionDriver,
  type HappierCollectionMotionValue,
} from './collection/collectionMotion.js';
export {
  HAPPIER_DISCLOSURE_DURATION_MS,
  HappierDisclosure,
  resolveHappierDisclosureFrameStyle,
  type HappierDisclosureBodyProps,
  type HappierControlledDisclosure,
  type HappierDisclosureHeaderRender,
  type HappierDisclosureHeaderState,
  type HappierDisclosureMotion,
  type HappierDisclosureMotionDriver,
  type HappierDisclosureProps,
} from './collection/Disclosure.js';
export {
  HAPPIER_DISCLOSURE_CHEVRON_METRICS,
  HappierChevron,
  HappierDisclosureChevron,
  type HappierChevronDirection,
} from './collection/DisclosureChevron.js';
export {
  HappierColumns,
  HappierColumn,
  type HappierColumnsProps,
  type HappierColumnProps,
} from './layout/Columns.js';
export {
  HAPPIER_PAGE_METRICS,
  isHappierPageRowNarrow,
  resolveHappierPageBackPlacement,
  type HappierPageBackPlacement,
} from './layout/pageMetrics.js';
export {
  HAPPIER_PAGE_TEXT,
  happierPageTextMetrics,
  resolveHappierPageTextStyle,
  resolveHappierTextStepStyle,
  type HappierPageTextRole,
  type HappierPageTextStep,
  type HappierPageTextWeight,
} from './layout/pageText.js';
export {
  HappierPageHeader,
  type HappierPageHeaderBackRender,
  type HappierPageHeaderMetaFact,
  type HappierPageHeaderProps,
  type HappierPageHeaderTextRender,
} from './layout/PageHeader.js';
export {
  HappierPageSectionContext,
  HappierPageSectionHeader,
  HappierPageSheet,
  HappierPageSheetGroup,
  happierPageRowDividerWidth,
  happierPageSheetShape,
  useHappierPageSection,
  withHappierPageSectionDividers,
  type HappierPageSection,
  type HappierPageSectionHeaderProps,
  type HappierPageSectionTextRender,
  type HappierPageSheetGroupProps,
  type HappierPageSheetProps,
} from './layout/PageSection.js';
export {
  HAPPIER_WIDGET_FRAME_METRICS,
  HAPPIER_WIDGET_FRAME_STYLES,
  HappierWidgetFrame,
  isHappierWidgetFrameSourceShown,
  resolveHappierWidgetFrameInsetPx,
  type HappierWidgetFramePlacement,
  type HappierWidgetFrameProps,
  type HappierWidgetFrameStyle,
  type HappierWidgetFrameTextRender,
  type HappierWidgetFrameTextRole,
} from './layout/WidgetFrame.js';
export {
  HappierPageChromeProvider,
  useHappierPageChrome,
  type HappierPageChrome,
} from './layout/pageChrome.js';
export {
  HAPPIER_COLUMN_MIN_WIDTH_PX,
  HAPPIER_COLUMN_GAP_PX,
  HAPPIER_COLUMN_ROW_GAP_PX,
  resolveHappierColumnCountForWidth,
} from './layout/columnLayout.js';
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
  HAPPIER_META_COLUMN_STYLE,
  HAPPIER_META_COLUMN_V1,
} from './text/metaColumn.js';
export {
  resolveHappierDiffViewerRequest,
  type HappierDiffViewerRequest,
} from './content/DiffViewer.js';
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
  HappierDotSpinner,
  HappierSpinner,
  HappierSpinnerHost,
  iconMatchedSpinnerSize,
  resolveHappierSpinnerPresentation,
  type HappierDotSpinnerModel,
  type HappierDotSpinnerMotion,
  type HappierSpinnerDotBoxStyle,
  type HappierSpinnerPresentation,
  type HappierSpinnerPresentationInput,
  resolveHappierWebSpinnerPresentation,
  type HappierWebSpinnerPresentation,
  type HappierWebSpinnerPresentationInput,
  type HappierWebSpinnerStyle,
  type HappierSpinnerProps,
} from './feedback/Spinner.js';
export { useHappierSpinnerKeyframes } from './feedback/spinnerKeyframes.js';
export {
  DEFAULT_HAPPIER_SPINNER_PAUSE_ID,
  DEFAULT_HAPPIER_SPINNER_SPEED_ID,
  DEFAULT_HAPPIER_SPINNER_STYLE_ID,
  HAPPIER_SPINNER_PAUSE_IDS,
  HAPPIER_SPINNER_SPEED_IDS,
  HAPPIER_SPINNER_STYLE_IDS,
  happierSpinnerStyleTimingControls,
  isHappierSpinnerStyleId,
  normalizeHappierSpinnerStyleId,
  type HappierSpinnerPauseId,
  type HappierSpinnerSpeedId,
  type HappierSpinnerStyleId,
} from './feedback/spinnerStyles.js';
export {
  HAPPIER_PRESS_FEEDBACK_V1,
  happierPressTransitionStyle,
} from './interaction/pressFeedback.js';
export {
  HAPPIER_SKELETON_PULSE_V1,
  HappierSkeletonBlock,
  HappierSkeletonRows,
  type HappierSkeletonBlockProps,
  type HappierSkeletonRowsProps,
} from './feedback/Skeleton.js';
export {
  HappierStatusDot,
  type HappierStatusDotProps,
} from './status/StatusDot.js';
export { HappierStatus, type HappierStatusProps } from './status/Status.js';
export {
  describeHappierDataChart,
  formatHappierDataShare,
  formatHappierDataValue,
  resolveHappierDataShares,
  resolveHappierDataTableColumns,
  type HappierDataColumn,
  type HappierDataColumnPriority,
  type HappierDataPoint,
  type HappierDataValue,
} from './data/dataModel.js';
export { HAPPIER_DATA_METRICS } from './data/dataText.js';
export {
  HappierDataMetric,
  type HappierDataMetricComparison,
  type HappierDataMetricProps,
} from './data/Metric.js';
export {
  HappierDataRows,
  HappierDataTable,
  type HappierDataRowsProps,
} from './data/DataRows.js';
export { HappierDataChart, type HappierDataChartProps } from './data/Chart.js';
export type {
  HappierCapsuleButtonEmphasis,
  HappierCapsuleColors,
  HappierCapsuleHost,
  HappierSurfaceGlyph,
  HappierSurfaceGlyphRenderer,
} from './status/capsuleHost.js';
export {
  HappierStatusCapsule,
  type HappierStatusCapsuleProps,
} from './status/StatusCapsule.js';
export {
  HAPPIER_INSTANT_AGENT_CURSOR_MOTION,
  HappierAgentCursor,
  resolveHappierAgentCursorPlacement,
  type HappierAgentCursorChannel,
  type HappierAgentCursorColors,
  type HappierAgentCursorLayerProps,
  type HappierAgentCursorMotion,
  type HappierAgentCursorMotionDriver,
  type HappierAgentCursorProps,
  type HappierAgentPageRect,
  type HappierAgentTarget,
} from './copresence/AgentCursor.js';
export {
  HappierPresenceCapsule,
  type HappierPresence,
  type HappierPresenceCapsuleCopy,
  type HappierPresenceCapsulePlacement,
  type HappierPresenceCapsuleProps,
  type HappierPresenceTakeControlResult,
} from './copresence/PresenceCapsule.js';
export {
  HappierActionPanel,
  HappierActionPanelSection,
  type HappierActionPanelProps,
  type HappierActionPanelSectionProps,
} from './interaction/ActionPanel.js';
export {
  HappierSelectionActionBar,
  resolveHappierSelectionActionBarLayout,
  type HappierSelectionActionBarAction,
  type HappierSelectionActionBarHost,
  type HappierSelectionActionBarLayout,
  type HappierSelectionActionBarOverflowItem,
  type HappierSelectionActionBarProps,
} from './interaction/SelectionActionBar.js';
export {
  HAPPIER_RELEASE_PREVIEW_METRICS,
  HappierReleaseOutcomePill,
  HappierReleaseOutcomeStrip,
  HappierReleasePreviewCard,
  HappierStagedMoveDock,
  type HappierReleaseGlyph,
  type HappierReleaseOutcome,
  type HappierReleasePreviewColors,
  type HappierReleasePreviewDensity,
  type HappierReleasePreviewHost,
  type HappierReleasePreviewIdentity,
  type HappierStagedMoveHint,
} from './interaction/ReleasePreview.js';
export {
  describeHappierDropAnnouncement,
  describeHappierDropOutcome,
  describeHappierSettledDrop,
  resolveHappierStagedMoveHints,
  type HappierDropAdmission,
  type HappierDropEffect,
  type HappierDropOutcomeVocabulary,
  type HappierDropSettlement,
  type HappierDropVerdict,
} from './interaction/dropOutcome.js';
export {
  HAPPIER_DRAG_GRIP_METRICS,
  HappierDragGrip,
  HappierDragGripTrigger,
  type HappierDragGripTriggerProps,
  type HappierDragGripDensity,
  type HappierDragGripProps,
} from './interaction/DragGrip.js';
export {
  HAPPIER_CARRIED_PREVIEW_OFFSET,
  HAPPIER_CARRIED_SOURCE_OPACITY,
  resolveHappierCarriedPreviewPlacement,
  resolveHappierDropChooserSections,
  resolveHappierStagedMoveKey,
  type HappierCarriedPreviewPlacement,
  type HappierDropChooserOption,
  type HappierDropChooserOptionInput,
  type HappierDropChooserSection,
  type HappierStagedMoveKeyIntent,
} from './interaction/dragDrop.js';
export {
  HAPPIER_FIND_BAR_METRICS,
  HappierFindBar,
  resolveHappierFindBarCount,
  type HappierFindBarColors,
  type HappierFindBarGlyph,
  type HappierFindBarHost,
  type HappierFindBarInputProps,
  type HappierFindBarKeyEvent,
  type HappierFindBarLabels,
  type HappierFindBarNote,
  type HappierFindBarProps,
} from './find/FindBar.js';
export type {
  FindCapabilities,
  FindController,
  FindCoverage,
  FindOptions,
  FindStatus,
  FindTextRange,
} from './find/findTypes.js';
export {
  HappierPressable,
  type HappierPressableProps,
  type HappierPressableRole,
  type HappierPressableState,
  type HappierPressableStyleState,
} from './interaction/Pressable.js';
export {
  HAPPIER_FOCUS_RING_DELEGATED_STYLE,
  HAPPIER_FOCUS_RING_V1,
  happierFocusRingStyle,
  isHappierFocusVisible,
  resolveHappierFocusRingVisible,
  type HappierFocusRingPlacement,
} from './interaction/focusVisible.js';
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
  HAPPIER_EMPTY_STATE_FRAME,
  HAPPIER_FRESHNESS_LINE_METRICS,
  HAPPIER_STATE_LINE_METRICS,
  HAPPIER_STATE_SIZE_METRICS,
  HappierInfoState,
  HappierInfoTile,
  HappierSurfaceStateFrame,
  HappierStateLine,
  HappierStateDetails,
  HappierFreshnessLine,
  resolveHappierStateAnnouncement,
  resolveHappierStateFailureGlyph,
  type HappierSurfaceStateKind,
  type HappierInfoStateProps,
  type HappierInfoTileProps,
  type HappierStateSize,
} from './state/InfoState.js';
export {
  formatHappierAsOfTime,
  resolveHappierFreshnessText,
} from './state/asOfTime.js';
export {
  HAPPIER_SCENE_ART_METRICS,
  HAPPIER_SCENE_IDS,
  HAPPIER_SCENE_PROP_IDS,
  HAPPIER_SCENE_RULES,
  HAPPIER_SCENE_VIEWBOX,
  defineHappierScene,
  defineHappierSceneProp,
  isHappierSceneId,
  resolveHappierScene,
  resolveHappierSceneArtSize,
  type HappierResolvedScene,
  type HappierResolvedSceneLayer,
  type HappierResolvedSceneMark,
  type HappierResolvedScenePlanet,
  type HappierSceneArtSize,
  type HappierSceneComposition,
  type HappierSceneDash,
  type HappierSceneDefinition,
  type HappierSceneHorizon,
  type HappierSceneId,
  type HappierSceneInput,
  type HappierSceneMark,
  type HappierSceneMoment,
  type HappierScenePlanetPlacement,
  type HappierScenePlanetState,
  type HappierScenePropDefinition,
  type HappierScenePropId,
  type HappierScenePropPlacement,
  type HappierSceneRenderRequest,
  type HappierSceneSky,
  type HappierSceneTone,
} from './state/scenes.js';
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
export { HappierSurface, type HappierSurfaceProps } from './layout/Surface.js';
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
  HAPPIER_BADGE_METRICS,
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
export { HappierStep, HappierStepMarkerView } from './content/Step.js';
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
// One typed field for Actions, Workflows, widget setup and the public Form, with the host's
// custom-picker port beneath it.
export {
  HappierInputField,
  type HappierInputFieldDescriptor,
  type HappierInputFieldProps,
} from './form/InputField.js';
export {
  HappierInputPickerButton,
  HappierInputPickerProvider,
  useHappierInputPicker,
  useHappierInputPickerPort,
  type HappierInputPickerAffordance,
  type HappierInputPickerField,
  type HappierInputPickerOption,
  type HappierInputPickerPort,
  type HappierInputPickerRequest,
  type HappierInputPickerResult,
  type HappierInputPickerState,
} from './form/inputPicker.js';
export {
  HAPPIER_SELECTION_TILE_TEXT,
  HappierSelectionTiles,
  type HappierActionSelectionTilesProps,
  type HappierMultipleSelectionTilesProps,
  type HappierSelectionTileFooterRenderer,
  type HappierSelectionTileGlyph,
  type HappierSelectionTileOption,
  type HappierSelectionTileTextRole,
  type HappierSelectionTilesColors,
  type HappierSelectionTilesGlyphRenderer,
  type HappierSelectionTilesProps,
  type HappierSelectionTilesTextRenderer,
  type HappierSingleSelectionTilesProps,
} from './form/SelectionTiles.js';
export {
  HappierTabs,
  isHappierTabSelected,
  resolveHappierTabKeySelection,
  useHappierTabPanelActivity,
  type HappierTabDescriptor,
  type HappierTabPanelActivity,
  type HappierTabRetention,
} from './navigation/Tabs.js';
// Shared control visuals (D6): the switch, the field-box select trigger, the
// segmented choice and the state-transition motion scale core and plugin
// controls read.
export { HAPPIER_MOTION_V1 } from './interaction/motion.js';
export {
  HAPPIER_SWITCH_METRICS,
  HappierSwitch,
  HappierSwitchNative,
  type HappierSwitchColors,
  type HappierSwitchProps,
  type HappierSwitchSize,
} from './form/Switch.js';
// The raised edge (one side of a bordered control's or surface's own border, lit on dark and
// lipped on light) and the gloss of a filled accent control: which side, and which states sit flat.
export {
  HAPPIER_RAISED_EDGE_SIDE,
  happierRaisedEdgeStyle,
  resolveHappierGloss,
  resolveHappierRaisedEdge,
  settleHappierRaisedEdge,
  type HappierRaisedEdge,
  type HappierRaisedEdgeSide,
  type HappierRaisedEdgeState,
} from './layout/raisedEdge.js';
export {
  HAPPIER_FIELD_BOX_METRICS,
  HAPPIER_FIELD_BOX_SHAPE,
  HAPPIER_FIELD_TEXT_METRICS,
  HAPPIER_SEARCH_FIELD_METRICS,
  HappierSearchFieldBox,
  HappierFieldBoxChevron,
  HappierFieldBoxTrigger,
  HappierFieldTextBox,
  resolveHappierFieldBoxLabel,
  resolveHappierFieldTextInputMetrics,
  type HappierFieldBoxColors,
  type HappierFieldBoxLabel,
  type HappierFieldBoxTriggerProps,
  type HappierFieldTextBoxProps,
} from './form/FieldBox.js';
export {
  filterHappierFieldDraft,
  resolveHappierFieldKeyboardType,
  useHappierFieldValueDraft,
  type HappierFieldKeyboardType,
  type HappierFieldValueDraftInput,
  type HappierFieldValueKind,
} from './form/fieldValueDraft.js';
export {
  HAPPIER_SEGMENTED_METRICS,
  HappierSegmentedChoice,
  type HappierSegmentedChoiceColors,
  type HappierSegmentedChoiceProps,
  type HappierSegmentedChoiceSegment,
  type HappierSegmentedSize,
} from './form/SegmentedChoice.js';
export {
  HAPPIER_RADIO_MARK_METRICS,
  HappierRadioMark,
} from './form/RadioMark.js';
// The Work primitives (INT I3 status language, the Work pane anatomy, the Work row and the work
// map): Happier core's Work tab, Inbox, Boards and workflow maps render through these, so a plugin's
// Work-style surface draws with exactly the same owners.
export {
  HAPPIER_WORK_STATUS_BUCKETS,
  HAPPIER_WORK_STATUS_BUCKET_LABEL_KEYS,
  HAPPIER_WORK_STATUS_SEMANTIC_TONE,
  resolveHappierWorkStatusBucketLabel,
  resolveHappierWorkStatusGlyphColor,
  resolveHappierWorkStatusSurfaceStyle,
  resolveHappierWorkStatusWordColor,
  type HappierWorkStateColors,
  type HappierWorkStatusBucket,
  type HappierWorkStatusColors,
  type HappierWorkStatusPresentation,
  type HappierWorkStatusTone,
} from './work/workStatus.js';
export {
  HAPPIER_WORK_PANE_METRICS,
  HAPPIER_WORK_TEXT,
  resolveHappierWorkTextStep,
  resolveHappierWorkTheme,
  type HappierWorkColors,
  type HappierWorkHost,
  type HappierWorkTextProps,
  type HappierWorkTextRole,
  type HappierWorkTextStep,
  type HappierWorkTheme,
} from './work/workTheme.js';
export {
  buildHappierWorkMap,
  formatHappierWorkMapNodeName,
  resolveHappierWorkMapNodePosition,
  type HappierWorkMap,
  type HappierWorkMapNode,
  type HappierWorkMapNodeDeclaration,
  type HappierWorkMapOpenTarget,
  type HappierWorkMapPlaced,
  type HappierWorkMapPlacement,
  type HappierWorkMapRelationships,
} from './work/workMap.js';
export {
  HAPPIER_WORK_MAP_LANE_MIN_WIDTH,
  HappierWorkMapView,
  type HappierWorkMapDensity,
  type HappierWorkMapNodeAppearance,
  type HappierWorkMapNodePresentation,
  type HappierWorkMapViewProps,
} from './work/WorkMapView.js';
export {
  HappierWorkFlatSheet,
  HappierWorkSection,
  type HappierWorkSectionProps,
} from './work/WorkSection.js';
export {
  HappierWorkRowShell,
  HappierWorkStatusWord,
  HappierWorkSummary,
  type HappierWorkRowShellProps,
  type HappierWorkSummaryPhase,
  type HappierWorkSummaryProps,
} from './work/WorkRow.js';
