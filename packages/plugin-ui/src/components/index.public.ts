export { projectWidgetGroupCellContent, resolveWidgetGroupCells, resolveWidgetGroupColumns, packWidgetGroupBands } from '../data/widgetGroupLayout.js';
export * from './Action.js';
export * from './UsageCharts.js';
export type { PublicUsageOriginalLabels, PublicUsageMetricId } from '../presentation/account/PublicProfileUsage.js';
export { HappierPublicProfile, HappierPublicProfileWidget, type HappierPublicProfileLabels, type HappierPublicProfileProps,
  type HappierPublicProfileUsageHost, type HappierPublicProfileUsageLabels } from './PublicProfile.js';
export { projectPublicUsageChartModels, projectPublicUsageRecords, type PublicUsageChartModels,
  type PublicUsageRecordKind } from '../data/publicUsageChartModels.js';
export { projectUsageCalendarArtModel } from '../data/publicUsageChartModels.js';
export { countUsageChartCalendarDates, projectUsageRiverWeekRange } from '../data/usageChartCalendar.js';
export type { UsageCalendarArtModel, UsageNinetyPlanetsModel, UsageStreakThreadModel, UsageDaysOnSurfaceModel,
  UsageRingedStreaksModel, UsageAroundPeriodModel, UsageWeeksSkylineModel, UsageMoonsModel, UsageMachinesModel,
  UsageProjectsModel, UsageAtmosphereModel, UsageGalaxyModel } from '../presentation/usage/charts/publicUsageChartModels.js';
export { ApprovalPendingNotice, type ApprovalPendingNoticeProps } from './ApprovalPendingNotice.js';
export { ApprovalPrompt, type ApprovalPromptProps } from './ApprovalPrompt.js';
export * from './Button.js';
export * from './Collection.js';
export {
  useCollectionSavedViewsControl,
  type CollectionSavedViewItem,
  type CollectionSavedViewsLabels,
  type CollectionSavedViewsControlProps,
} from './CollectionSavedViews.js';
export * from './CollectionFilter.js';
export { CollectionConditionEditor, type CollectionConditionEditorProps } from './CollectionConditionEditor.js';
export {
  HAPPIER_COLLECTION_CONDITION_EDITOR_METRICS,
  HappierCollectionConditionEditor,
  type HappierCollectionConditionEditorHost,
  type HappierCollectionConditionEditorLabels,
  type HappierCollectionConditionEditorProps,
  type HappierCollectionConditionIcon,
  type HappierCollectionConditionTextRole,
  type HappierCollectionConditionValuePicker,
} from '../presentation/collection/CollectionConditionEditor.js';
export { CollectionToolbar, type CollectionToolbarFreshness, type CollectionToolbarProps } from './CollectionToolbar.js';
export type { CollectionVirtualizer, CollectionVirtualizerHandle, CollectionVirtualizerRequest } from '../presentation/collection/collectionVirtualizer.js';
export * from './Content.js';
export { useResizableSize, type ResizableSizeInput, type ResizableSizeResult, type DockedPaneResizeCommitMeta } from '../presentation/layout/resize/useResizableSize.js';
export { HappierResizeHandle } from '../presentation/layout/resize/HappierResizeHandle.js';
export {
  HappierMemoryFactRow,
  type HappierMemoryFactItemProps,
  type HappierMemoryFactRowHost,
  type HappierMemoryFactRowProps,
} from '../presentation/content/MemoryFactRow.js';
export { Chart, DataRows, DataTable, Metric, type ChartProps, type DataRowsProps, type MetricProps } from './Data.js';
export {
  AgentCursor,
  PresenceCapsule,
  StatusCapsule,
  type AgentCursorProps,
  type PresenceCapsuleProps,
  type StatusCapsuleProps,
} from './Copresence.js';
export { Avatar, type AvatarProps } from './Avatar.js';
export { DetailsPane, DetailsPaneFooter, type DetailsPaneProps } from './DetailsPane.js';
export { DetailsPaneOpenAsPageButton, type DetailsPaneOpenAsPageButtonProps } from './DetailsPaneOpenAsPageButton.js';
export { DiffStat, type DiffStatProps } from './DiffStat.js';
export { InlineCode, type InlineCodeProps } from './InlineCode.js';
export { TaskStatusGlyph, type TaskStatusCategory, type TaskStatusGlyphProps } from './TaskStatusGlyph.js';
export { CheckStatusGlyph, type CheckStatusGlyphProps, type CheckStatusKind } from './CheckStatusGlyph.js';
export { AnsiText, type AnsiTextProps } from './AnsiText.js';
export { PaneHeaderContent, type PaneHeaderContentProps, type PaneHeaderContentLineSegment } from './PaneHeaderContent.js';
export {
  type PluginUiFocusTarget,
  usePluginUiFocusTarget,
} from './Focus.js';
export { ComposerStatusBadge, type ComposerStatusBadgeEmphasis, type ComposerStatusBadgeProps, type ComposerStatusBadgeTone } from './ComposerStatusBadge.js';
export * from './Foundation.js';
export * from './Form.js';
export {
  FollowPolicyEditor,
  type FollowPolicyEditorDelivery, type FollowPolicyEditorEvent, type FollowPolicyEditorProps,
  type FollowPolicyEditorReceiver,
} from './FollowPolicyEditor.js';
export { Icon, type IconName, type IconProps } from './Icon.js';
export * from './Image.js';
export { MotionFeedback, type MotionFeedbackProps } from './MotionFeedback.js';
export { ModalHeader, type ModalHeaderProps } from './ModalHeader.js';
export * from './StoredImage.js';
export * from './Layout.js';
export { LinkDelivery, type LinkDeliveryProps } from './LinkDelivery.js';
export {
  SettingRow, SettingStatusLine, SettingValueSlot,
  type SettingRowLayout, type SettingRowProps, type SettingStatusLineProps, type SettingValueSlotProps,
} from './Setting.js';
export {
  List, Item, ItemGroup,
  type ListSearchProps, type ListMultiSelectionCapabilityProps, type ListSingleChoiceCapabilityProps, type ListSelectionProps,
  type ListHeaderContext, type ListSectionData, type ListProps, type ListSectionProps,
  type ItemProps, type ListItemProps, type ListAccessibilityPattern, type ItemGroupProps,
} from './List.js';
export { CountedDisclosureItem, type CountedDisclosureItemProps } from './CountedDisclosureItem.js';
export {
  TechnicalDetailsDisclosure, type TechnicalDetailsDisclosureProps, type TechnicalDetailsLine,
} from './TechnicalDetailsDisclosure.js';
export { ItemAddRow, type ItemAddRowProps } from './ItemAddRow.js';
export * from './NavigationList.js';
export * from './PageHeader.js';
export {
  createListMultiSelectionStore, useListMultiSelectionController,
  ListMultiSelectionProvider, useOptionalListMultiSelectionStore,
  useListMultiSelectionStoreSnapshot, useListMultiSelectionSnapshot, useListMultiSelectionRow,
  ListSelectionActionBar,
  type ListMultiSelectionKey, type ListMultiSelectionSnapshot, type ListMultiSelectionActions,
  type ListMultiSelectionStore, type UseListMultiSelectionControllerInput,
  type ListMultiSelectionProviderProps, type ListMultiSelectionRow,
  type ListBulkAction, type ListSelectionActionBarProps,
} from './ListMultiSelection.js';
export * from './Overlay.js';
export {
  usePluginAccessibility,
  usePluginTheme,
  usePluginTranslation,
  useSurfaceContext,
  type PluginAccessibilityFacts,
  type PluginTranslate,
  type PluginTranslationValues,
} from './PluginUiProvider.js';
export * from './SelectionTiles.js';
export {
  ExecutableParticipantPicker,
  type ExecutableParticipantPickerOption,
  type ExecutableParticipantPickerSection,
  type ExecutableParticipantPickerSelection,
  type ExecutableParticipantPickerProps,
} from './ExecutableParticipantPicker.js';
export * from './Session.js';
export * from './Spinner.js';
export * from './State.js';
export * from './Status.js';
export * from './Step.js';
export * from './Setup.js';
export * from './Voice.js';
export * from './Surface.js';
export * from './Tabs.js';
export { Timeline, type TimelineProps, type TimelineItemContent } from './Timeline.js';
export { ThreadMessage, type ThreadMessageProps } from './ThreadMessage.js';
export { ReplyQuote, type ReplyQuoteProps } from './ReplyQuote.js';
export { HappierReplyQuote, type HappierReplyQuoteProps, type HappierReplyQuoteSource, type HappierReplyQuoteTextProps } from '../presentation/content/ReplyQuote.js';
export { ReturnedAnswerQuote, type ReturnedAnswerOutcome, type ReturnedAnswerQuestion, type ReturnedAnswerQuoteProps } from './ReturnedAnswerQuote.js';
export {
  HappierReturnedAnswerQuote,
  type HappierReturnedAnswerOutcome,
  type HappierReturnedAnswerQuestion,
  type HappierReturnedAnswerQuoteActionProps,
  type HappierReturnedAnswerQuoteLabels,
  type HappierReturnedAnswerQuoteProps,
  type HappierReturnedAnswerQuoteTextProps,
} from '../presentation/content/ReturnedAnswerQuote.js';
export { HappierThreadMessage, type HappierThreadMessageProps } from '../presentation/content/ThreadMessage.js';
export {
  MemoryDuplicateChoice,
  type MemoryDuplicateCandidate,
  type MemoryDuplicateChoiceKind,
  type MemoryDuplicateChoiceProps,
} from './MemoryDuplicateChoice.js';
export {
  HappierMemoryDuplicateChoice,
  type HappierMemoryDuplicateCandidate,
  type HappierMemoryDuplicateChoiceControlProps,
  type HappierMemoryDuplicateChoiceKind,
  type HappierMemoryDuplicateChoiceLabels,
  type HappierMemoryDuplicateChoiceProps,
  type HappierMemoryDuplicateChoiceTextProps,
} from '../presentation/content/MemoryDuplicateChoice.js';
export {
  DocEditProposal,
  type DocEditProposalAction,
  type DocEditProposalFooter,
  type DocEditProposalLine,
  type DocEditProposalProps,
  type DocEditProposalState,
} from './DocEditProposal.js';
export {
  HappierDocEditProposal,
  type HappierDocEditProposalAction,
  type HappierDocEditProposalButtonProps,
  type HappierDocEditProposalDiffProps,
  type HappierDocEditProposalFooter,
  type HappierDocEditProposalLine,
  type HappierDocEditProposalMark,
  type HappierDocEditProposalMarkProps,
  type HappierDocEditProposalProps,
  type HappierDocEditProposalState,
  type HappierDocEditProposalTextProps,
  type HappierDocEditProposalTone,
} from '../presentation/content/DocEditProposal.js';
export * from './Text.js';
export * from './TargetedSurface.js';
export { WidgetSurface, type WidgetSurfaceProps } from './WidgetSurface.js';
export { WidgetFrame, type WidgetFrameProps } from './WidgetFrame.js';
export { WidgetGlanceRow, type WidgetGlanceRowProps } from './WidgetGlanceRow.js';
export { FloatingFrame, type FloatingFrameProps } from './FloatingFrame.js';
export { Tree, type TreeItem, type TreeProps } from './Tree.js';
export { DragSource, DropTarget, type DragSourceProps, type DropTargetProps } from './EntityDragDrop.js';
export {
  WidgetPresentationProvider,
  useWidgetPresentation,
  type WidgetPresentation,
  type WidgetPresentationProviderProps,
} from './WidgetPresentation.js';

// Neutral owners consumed by the migrated public author fixtures. The author
// adapters above remain distinct from the shared controlled presentation.
export {
  FloatingFrame as HappierFloatingFrame,
  type FloatingFrameProps as HappierFloatingFrameProps,
} from '../presentation/layout/FloatingFrame.js';
export { resolveFloatingFrameRect, type FrameRect } from '../presentation/layout/floatingFrameGeometry.js';
export { resolveFloatingFrameResizeRect } from '../presentation/layout/floatingFrameGeometry.js';
export { HAPPIER_MIDDLE_ELLIPSIS_STYLE, splitForWebMiddleEllipsis } from '../presentation/text/middleEllipsis.js';
export { HAPPIER_BALANCED_TEXT_WRAP } from '../presentation/text/balancedTextWrap.js';
export {
  HAPPIER_TECHNICAL_DETAILS_METRICS, HappierTechnicalDetailsDisclosure,
  type HappierTechnicalDetailsContentProps, type HappierTechnicalDetailsDisclosureProps, type HappierTechnicalDetailsLine,
  type HappierTechnicalDetailsSpace, type HappierTechnicalDetailsTextRender,
} from '../presentation/collection/TechnicalDetailsDisclosure.js';
export {
  HAPPIER_MODAL_HEADER_METRICS, HappierModalHeader, resolveHappierModalHeaderLayout,
  type HappierModalHeaderLayout, type HappierModalHeaderProps, type HappierModalHeaderSpace,
  type HappierModalHeaderTextRender,
} from '../presentation/layout/ModalHeader.js';
export { HAPPIER_TEXT_INPUT_FOCUS_RESET_STYLE, HAPPIER_TEXT_INPUT_WEB_MARKER } from '../presentation/interaction/focusVisible.js';
export {
  HappierApprovalPendingNotice, HappierNoticeLine,
  type HappierApprovalPendingNoticeProps, type HappierApprovalPendingNoticeTextRender,
  type HappierNoticeLineProps, type HappierNoticeLineTextRender,
} from '../presentation/interaction/ApprovalPendingNotice.js';
export {
  HappierItemAddRow, type HappierItemAddRowContentProps, type HappierItemAddRowProps,
  type HappierItemAddRowRenderProps,
} from '../presentation/collection/ItemAddRow.js';
export { HappierRowOperationContext } from '../presentation/collection/rowOperation.js';
export { HappierSkeletonPulse, type HappierSkeletonPulseProps } from '../presentation/feedback/Skeleton.js';
export { type HappierTabLabels, resolveHappierTabGlyphOnly } from '../presentation/navigation/Tabs.js';
export { resolveHappierPageRowDetailLayout } from '../presentation/layout/pageRowDetail.js';
export { splitHappierPagePrimaryOperation } from '../presentation/layout/pageOperations.js';
export { useHappierCopyFeedback } from '../presentation/interaction/copyFeedback.js';
export { useHappierItemOverflowState } from '../presentation/collection/ItemOverflow.js';
export { useHappierTextSelectability } from '../presentation/text/Text.js';
export { useHappierTreeRowLineHeight } from '../presentation/navigation/TreeRow.js';
export { HappierStack } from '../presentation/layout/Layout.js';
export { HappierText } from '../presentation/text/Text.js';
export { resolveHappierTreeFocusKey, type HappierTreeNode } from '../presentation/navigation/treeInteraction.js';
export { useHappierCollection } from '../presentation/collection/useCollection.js';
export type { HappierCollectionPresentation } from '../presentation/collection/collectionTable.js';
export { HappierDisclosure } from '../presentation/collection/Disclosure.js';
export { HAPPIER_INSTANT_DISCLOSURE_MOTION } from '../presentation/collection/collectionMotion.js';
export { HappierPressable } from '../presentation/interaction/Pressable.js';
export { HappierStateLine } from '../presentation/state/InfoState.js';
export { StackedSeriesChart, type StackedSeriesBand } from '../presentation/data/StackedSeriesChart.js';
export { Heatmap } from '../presentation/data/Heatmap.js';
export { DotGrid } from '../presentation/data/DotGrid.js';
export { IntervalTimeline } from '../presentation/data/IntervalTimeline.js';
export { CapacityBar } from '../presentation/data/CapacityBar.js';
export { BurnUpChart } from '../presentation/data/BurnUpChart.js';
export { RankedRows } from '../presentation/data/RankedRows.js';
export { CompositionStrip } from '../presentation/data/CompositionStrip.js';
export { OutcomeScatter } from '../presentation/data/OutcomeScatter.js';
export { OutcomeFunnel } from '../presentation/data/OutcomeFunnel.js';
export { CoreLoadBars } from '../presentation/data/CoreLoadBars.js';
export { Sunburst } from '../presentation/data/Sunburst.js';
export { Treemap, type HappierChartPart } from '../presentation/data/Treemap.js';
export { layoutHappierTreemap, squarifyHappierTreemap, createHappierTreemapHitGrid } from '../presentation/data/treemapLayout.js';
export { layoutHappierSunburst, hitHappierSunburst } from '../presentation/data/sunburstLayout.js';

// Domain-neutral shared owners are explicit author exports; mounted host controls stay private.
export {
  HappierArtifactPreviewCard,
  type HappierArtifactPreview,
  type HappierArtifactPreviewCardHost,
  type HappierArtifactPreviewCardProps,
} from '../presentation/artifacts/ArtifactPreviewCard.js';
export {
  HappierArtifactRevisionList,
  type HappierArtifactRevisionListProps,
  type HappierArtifactRevisionRow,
} from '../presentation/artifacts/ArtifactRevisionList.js';
export {
  HappierHtmlSandboxFrame,
  type HappierHtmlSandboxFrameHost,
  type HappierHtmlSandboxFrameProps,
} from '../presentation/artifacts/HtmlSandboxFrame.js';
export {
  HappierPublicLinkCard,
  type HappierPublicLinkCardProps,
} from '../presentation/artifacts/PublicLinkCard.js';
export {
  HAPPIER_COLLECTION_LIST_METRICS,
  HAPPIER_COLLECTION_LIST_ROW_STYLE,
  HAPPIER_COLLECTION_LIST_TEXT,
  HappierCollectionList,
  HappierCollectionListGroupLabel,
  HappierCollectionListMark,
  resolveHappierCollectionListRowPadding,
  type HappierCollectionListFilters,
  type HappierCollectionListHost,
  type HappierCollectionListProps,
  type HappierCollectionListSearch,
  type HappierCollectionListTextRole,
  useHappierCollectionDraftRowTitle,
} from '../presentation/collection/CollectionList.js';
export {
  HappierCountedDisclosure,
  type HappierCountedDisclosureContentProps,
  type HappierCountedDisclosureFrameProps,
  type HappierCountedDisclosureHeaderState,
  type HappierCountedDisclosureProps,
} from '../presentation/collection/CountedDisclosure.js';
export {
  HappierListOverflowFooter,
  leadHappierListRows,
  type HappierListOverflowFooterLabels,
  type HappierListOverflowFooterProps,
} from '../presentation/collection/ListOverflowFooter.js';
export {
  HAPPIER_DISCLOSURE_DURATION_MS,
  resolveHappierDisclosureFrameStyle,
  type HappierControlledDisclosure,
  type HappierDisclosureBodyProps,
  type HappierDisclosureHeaderRender,
  type HappierDisclosureHeaderState,
  type HappierDisclosureMotion,
  type HappierDisclosureMotionDriver,
  type HappierDisclosureProps,
} from '../presentation/collection/Disclosure.js';
export {
  HAPPIER_DISCLOSURE_CHEVRON_METRICS,
  HappierChevron,
  HappierDisclosureChevron,
  type HappierChevronDirection,
} from '../presentation/collection/DisclosureChevron.js';
export {
  HappierItemGroup,
  HappierItemGroupBehavior,
  type HappierItemGroupBehaviorProps,
  type HappierItemGroupItemBehaviorInput,
  type HappierItemGroupProps,
  type HappierItemGroupRadioFocusable,
  useHappierItemGroupItemBehavior,
} from '../presentation/collection/ItemGroup.js';
export {
  HappierItemOverflow,
  type HappierItemOverflowAction,
  type HappierItemOverflowProps,
  type HappierItemOverflowRenderInput,
} from '../presentation/collection/ItemOverflow.js';
export {
  HappierList,
  HappierListItem,
  HappierListSection,
  resolveHappierPageRowFieldMaxWidth,
  type HappierListItemProps,
  type HappierListProps,
  type HappierListSectionProps,
} from '../presentation/collection/List.js';
export {
  HappierListDetailLayout,
  type HappierListDetailLayoutProps,
  type HappierListDetailLayoutState,
} from '../presentation/collection/ListDetailLayout.js';
export {
  HappierRowActionRevealSlot,
  type HappierRowActionRevealSlotProps,
} from '../presentation/collection/RowActionRevealSlot.js';
export {
  type HappierCollectionIndexView,
  type HappierCollectionLayoutMode,
  type HappierCollectionLayoutState,
  useHappierCollectionIndexView,
  useHappierCollectionLayout,
} from '../presentation/collection/collectionLayout.js';
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
  type HappierCollectionTree,
  type HappierCollectionTreeNode,
  type HappierCollectionVisitMemory,
  type HappierCollectionWindow,
} from '../presentation/collection/collectionModel.js';
export {
  rankHappierQueryMatches,
  type HappierQueryRankOptions,
  type HappierQueryText,
} from '../presentation/collection/queryRank.js';
export {
  HAPPIER_COLLECTION_INSTANT_MOTION,
  resolveHappierCollectionTrackStyle,
  type HappierCollectionAnimatedViewProps,
  type HappierCollectionMotionDriver,
  type HappierCollectionMotionValue,
} from '../presentation/collection/collectionMotion.js';
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
  type HappierCollectionTableColumn,
  type HappierCollectionTransitionCell,
  type HappierCollectionTransitionEasing,
  type HappierCollectionTransitionPlan,
} from '../presentation/collection/collectionTable.js';
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
} from '../presentation/collection/multiSelection.js';
export {
  resolveHappierItemBehavior,
  resolveHappierItemGroupConstraints,
  resolveHappierItemSemantics,
  resolveHappierRovingSelection,
  type HappierItemBehavior,
  type HappierItemBehaviorInput,
  type HappierItemDensity,
  type HappierItemSemanticInput,
  type HappierItemSemanticState,
  type HappierRovingEntry,
  type HappierSelectableRole,
} from '../presentation/collection/semantics.js';
export {
  type HappierCollectionActions,
  type HappierCollectionDraft,
  type HappierCollectionDraftInput,
  type HappierCollectionModel,
  type HappierCollectionModelInput,
  type HappierCollectionViewport,
  useHappierCollectionVisit,
} from '../presentation/collection/useCollection.js';
export {
  normalizeHappierCodeLanguage,
  resolveHappierCodeBlockLayout,
  type HappierCodeBlockBehaviorInput,
  useHappierCodeBlockBehavior,
} from '../presentation/content/CodeBlock.js';
export {
  HappierDiffStat,
  formatHappierDiffStat,
  type HappierDiffStatKind,
  type HappierDiffStatProps,
  type HappierDiffStatTextProps,
} from '../presentation/content/DiffStat.js';
export {
  HAPPIER_INLINE_CODE_METRICS,
  HappierInlineCode,
  type HappierInlineCodeProps,
  type HappierInlineCodeTextProps,
} from '../presentation/text/InlineCode.js';
export {
  resolveHappierDiffViewerRequest,
  type HappierDiffViewerRequest,
} from '../presentation/content/DiffViewer.js';
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
  splitHappierBannerPoint,
  type HappierBannerPoint,
  type HappierMetadataEntry,
} from '../presentation/content/Foundation.js';
export {
  HAPPIER_ICON_NAMES,
  isHappierIconName,
  resolveHappierIconSize,
  type HappierIconName,
  type HappierIconSize,
} from '../presentation/content/Icon.js';
export {
  HappierBrandMark,
  resolveHappierBrandFallback,
  resolveHappierImagePixels,
  type HappierBrandMarkProps,
  type HappierImageSize,
} from '../presentation/content/Image.js';
export {
  HappierMarkdown,
  type HappierMarkdownProps,
  type HappierMarkdownRenderInput,
  type MarkdownInlineReference,
  type MarkdownInlineReferences,
} from '../presentation/content/Markdown.js';
export {
  HappierSetupSteps,
  type HappierSetupStep,
  type HappierSetupStepGlyphState,
  type HappierSetupStepState,
  type HappierSetupStepTitlePresentation,
  type HappierSetupStepsProps,
  type HappierSetupStepsVariant,
} from '../presentation/content/SetupSteps.js';
export {
  HappierStep,
  HappierStepMarkerView,
} from '../presentation/content/Step.js';
export {
  HappierStoredImage,
  type HappierStoredImageHost,
  type HappierStoredImageProps,
} from '../presentation/content/StoredImage.js';
export {
  resolveHappierStoredImageDimensions,
  resolveHappierStoredImageLayout,
  type HappierStoredImageDimensions,
} from '../presentation/content/storedImageLayout.js';
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
  type HappierAgentPoint,
  type HappierAgentTarget,
} from '../presentation/copresence/AgentCursor.js';
export {
  HappierPresenceCapsule,
  type HappierPresence,
  type HappierPresenceCapsuleCopy,
  type HappierPresenceCapsulePlacement,
  type HappierPresenceCapsuleProps,
  type HappierPresenceTakeControlResult,
} from '../presentation/copresence/PresenceCapsule.js';
export {
  type BurnUpChartProps,
} from '../presentation/data/BurnUpChart.js';
export {
  type CapacityBarProps,
} from '../presentation/data/CapacityBar.js';
export {
  HappierDataChart,
  type HappierDataChartProps,
} from '../presentation/data/Chart.js';
export {
  type CompositionSegment,
  type CompositionStripProps,
} from '../presentation/data/CompositionStrip.js';
export {
  type CoreLoadBar,
  type CoreLoadBarsProps,
} from '../presentation/data/CoreLoadBars.js';
export {
  HappierDataRows,
  HappierDataTable,
  type HappierDataRowsProps,
} from '../presentation/data/DataRows.js';
export {
  type DotGridProps,
} from '../presentation/data/DotGrid.js';
export {
  resolveFirstFullyVisibleColumn,
  type HappierGridAxis,
  type HappierGridCell,
  type HappierGridFrame,
  type HeatmapProps,
} from '../presentation/data/Heatmap.js';
export {
  type IntervalTimelineInterval,
  type IntervalTimelineProps,
} from '../presentation/data/IntervalTimeline.js';
export {
  HappierDataMetric,
  type HappierDataMetricComparison,
  type HappierDataMetricProps,
} from '../presentation/data/Metric.js';
export {
  type OutcomeFunnelProps,
  type OutcomeFunnelStep,
} from '../presentation/data/OutcomeFunnel.js';
export {
  type OutcomeScatterGuide,
  type OutcomeScatterPoint,
  type OutcomeScatterProps,
} from '../presentation/data/OutcomeScatter.js';
export {
  type RankedRowsProps,
} from '../presentation/data/RankedRows.js';
export {
  type StackedSeriesChartProps,
} from '../presentation/data/StackedSeriesChart.js';
export {
  type HappierSunburstProps,
} from '../presentation/data/Sunburst.js';
export {
  type HappierTreemapProps,
} from '../presentation/data/Treemap.js';
export {
  HAPPIER_SERIES_RAMP_ALPHAS,
  describeHappierDataChart,
  describeHappierSeriesBucket,
  formatHappierDataBytes,
  formatHappierDataBytesParts,
  formatHappierDataShare,
  formatHappierDataValue,
  mixHappierColorOverPaper,
  resolveHappierDataShares,
  resolveHappierDataTableColumns,
  resolveHappierSeriesRampColor,
  type HappierDataBytesKind,
  type HappierDataColumn,
  type HappierDataColumnPriority,
  type HappierDataPoint,
  type HappierDataValue,
  type HappierSeries,
  type HappierSeriesBucket,
  type HappierSeriesPoint,
} from '../presentation/data/dataModel.js';
export {
  HAPPIER_DATA_METRICS,
} from '../presentation/data/dataText.js';
export {
  HAPPIER_SUNBURST_SMALLER_SUFFIX,
  type HappierSunburstArc,
  type HappierSunburstLayoutOptions,
  type HappierSunburstNode,
  type HappierSunburstRing,
} from '../presentation/data/sunburstLayout.js';
export {
  HAPPIER_TREEMAP_SMALLER_SUFFIX,
  type HappierTreemapLayoutOptions,
  type HappierTreemapNode,
  type HappierTreemapRect,
  type HappierTreemapTile,
} from '../presentation/data/treemapLayout.js';
export {
  HAPPIER_SKELETON_PULSE_V1,
  HappierSkeletonBlock,
  HappierSkeletonRows,
  type HappierSkeletonBlockProps,
  type HappierSkeletonRowGeometry,
  type HappierSkeletonRowsProps,
} from '../presentation/feedback/Skeleton.js';
export {
  HappierDotSpinner,
  HappierSpinner,
  iconMatchedSpinnerSize,
  resolveHappierSpinnerPresentation,
  resolveHappierWebSpinnerPresentation,
  type HappierDotSpinnerModel,
  type HappierDotSpinnerMotion,
  type HappierSpinnerDotBoxStyle,
  type HappierSpinnerPresentation,
  type HappierSpinnerPresentationInput,
  type HappierSpinnerProps,
  type HappierWebSpinnerPresentation,
  type HappierWebSpinnerPresentationInput,
  type HappierWebSpinnerStyle,
} from '../presentation/feedback/Spinner.js';
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
} from '../presentation/feedback/spinnerStyles.js';
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
} from '../presentation/find/FindBar.js';
export {
  HappierFindHighlightedText,
  sliceFindRanges,
  type FindMarkStyle,
  type HappierFindHighlightedTextProps,
} from '../presentation/find/FindHighlightedText.js';
export {
  type FindCapabilities,
  type FindController,
  type FindCoverage,
  type FindOptions,
  type FindStatus,
  type FindTextRange,
} from '../presentation/find/findTypes.js';
export {
  matchFindText,
  type FindTextMatchRange,
  type FindTextMatchResult,
} from '../presentation/find/matchFindText.js';
export {
  type FindSurfaceRegistration,
} from '../presentation/find/useFindSurfaceRegistration.js';
export {
  HAPPIER_FIELD_BOX_METRICS,
  HAPPIER_FIELD_BOX_SHAPE,
  HAPPIER_FIELD_TEXT_METRICS,
  HAPPIER_SEARCH_FIELD_METRICS,
  HappierFieldBoxChevron,
  HappierFieldBoxTrigger,
  HappierFieldTextBox,
  HappierSearchFieldBox,
  resolveHappierFieldBoxLabel,
  resolveHappierFieldTextInputMetrics,
  type HappierFieldBoxColors,
  type HappierFieldBoxLabel,
  type HappierFieldBoxTriggerProps,
  type HappierFieldTextBoxProps,
  type HappierFieldTextPresentation,
} from '../presentation/form/FieldBox.js';
export {
  HappierFieldStepper,
} from '../presentation/form/FieldStepper.js';
export {
  HappierField,
  HappierForm,
  HappierFormActions,
  HappierSelect,
  HappierTextField,
  HappierToggle,
  HappierValidationMessage,
  planHappierSelectOptions,
  resolveHappierFormPending,
  type HappierFieldProps,
  type HappierFormActionsProps,
  type HappierFormPendingInput,
  type HappierFormProps,
  type HappierSelectOption,
  type HappierTextFieldProps,
  type HappierValidationMessageProps,
  useHappierFormSubmission,
} from '../presentation/form/Fields.js';
export {
  HappierInputField,
  type HappierInputFieldDescriptor,
  type HappierInputFieldProps,
} from '../presentation/form/InputField.js';
export {
  HappierLocalDateTimeField,
  type HappierLocalDateTimeFieldProps,
  type HappierLocalDateTimePickerHost,
  type HappierLocalDateTimePickerMode,
  type HappierLocalDateTimePickerRequest,
} from '../presentation/form/LocalDateTimeField.js';
export {
  HAPPIER_RADIO_CHOICE_LIST_METRICS,
  HappierRadioChoiceList,
  type HappierRadioChoiceOption,
} from '../presentation/form/RadioChoiceList.js';
export {
  HAPPIER_RADIO_MARK_METRICS,
  HappierRadioMark,
} from '../presentation/form/RadioMark.js';
export {
  HAPPIER_SEGMENTED_METRICS,
  HappierSegmentedChoice,
  type HappierSegmentedChoiceColors,
  type HappierSegmentedChoiceProps,
  type HappierSegmentedChoiceSegment,
  type HappierSegmentedSize,
} from '../presentation/form/SegmentedChoice.js';
export {
  HappierSegmentedChoiceRow,
  resolveHappierSegmentedChoiceRow,
  type HappierSegmentedChoiceRowColors,
  type HappierSegmentedChoiceRowModel,
  type HappierSegmentedChoiceRowOption,
  type HappierSegmentedChoiceRowProps,
} from '../presentation/form/SegmentedChoiceRow.js';
export {
  HAPPIER_SELECTION_TILE_TEXT,
  HappierSelectionTiles,
  resolveHappierSelectionTileText,
  type HappierSelectionTileTextStep,
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
} from '../presentation/form/SelectionTiles.js';
export {
  HAPPIER_SETTING_INPUT_STYLE,
  HAPPIER_SETTING_VALUE_SLOT_METRICS,
  HappierSettingStatusLine,
  HappierSettingValueSlot,
  type HappierSettingRowLayout,
  type HappierSettingStatusLineProps,
  type HappierSettingValueSlotProps,
} from '../presentation/form/SettingField.js';
export {
  HAPPIER_SWITCH_METRICS,
  HappierSwitch,
  HappierSwitchNative,
  type HappierSwitchColors,
  type HappierSwitchProps,
  type HappierSwitchSize,
} from '../presentation/form/Switch.js';
export {
  HAPPIER_SEGMENTED_CHOICES_MAX,
  HAPPIER_SEGMENTED_LABEL_MAX_CHARS,
  patchHappierActionInputPath,
  readHappierActionInputPath,
  resolveHappierActionFieldPresentation,
  resolveHappierChoiceControl,
  type HappierActionFieldPresentation,
  writeHappierActionInputPath,
} from '../presentation/form/actionInputFields.js';
export {
  filterHappierFieldDraft,
  resolveHappierFieldKeyboardType,
  type HappierFieldKeyboardType,
  type HappierFieldStepperBounds,
  type HappierFieldValueDraftInput,
  type HappierFieldValueKind,
  useHappierFieldValueDraft,
} from '../presentation/form/fieldValueDraft.js';
export {
  HappierInputPickerButton,
  type HappierInputPickerAffordance,
  type HappierInputPickerField,
  type HappierInputPickerOption,
  type HappierInputPickerRequest,
  type HappierInputPickerResult,
  type HappierInputPickerState,
  useHappierInputPicker,
} from '../presentation/form/inputPicker.js';
export {
  formatHappierLocalDateInput,
  formatHappierLocalTimeInput,
  parseHappierLocalDateTime,
  resolveHappierFutureLocalDateTime,
  toHappierLocalDateTimeDraft,
  type HappierLocalDateTimeDraft,
} from '../presentation/form/localDateTimeValue.js';
export {
  HappierActionPanel,
  HappierActionPanelSection,
  type HappierActionPanelProps,
  type HappierActionPanelSectionProps,
} from '../presentation/interaction/ActionPanel.js';
export {
  HappierApprovalPromptChrome,
  type HappierApprovalPromptChromeProps,
  type HappierApprovalPromptTextRender,
} from '../presentation/interaction/ApprovalPromptChrome.js';
export {
  HappierComposerChip,
  type HappierComposerChipProps,
} from '../presentation/interaction/ComposerChip.js';
export {
  HappierDecisionBar,
  type HappierDecisionAction,
  type HappierDecisionBarProps,
  type HappierDecisionButtonProps,
} from '../presentation/interaction/DecisionBar.js';
export {
  HAPPIER_DRAG_GRIP_METRICS,
  HappierDragGrip,
  HappierDragGripTrigger,
  type HappierDragGripDensity,
  type HappierDragGripProps,
  type HappierDragGripTriggerProps,
} from '../presentation/interaction/DragGrip.js';
export {
  HAPPIER_DROP_INDICATOR_METRICS,
  HappierDropInsertionLine,
  HappierDropTargetOutline,
} from '../presentation/interaction/DropTargetOutline.js';
export {
  HAPPIER_MENU_ROW_METRICS,
  HAPPIER_MENU_ROW_TEXT,
  matchesHappierMenuQuery,
  resolveHappierMenuContent,
  resolveHappierMenuKeyAction,
  resolveHappierMenuRadioGroups,
  resolveHappierMenuSelection,
  resolveHappierMenuTypeahead,
  resolveHappierPopoverPlacement,
  type HappierMenuContent,
  type HappierMenuEntry,
  type HappierMenuGroupDescriptor,
  type HappierMenuInteractionInput,
  type HappierMenuItemDescriptor,
  type HappierMenuKeyAction,
  type HappierMenuRadioGroupDescriptor,
  type HappierPopoverPlacement,
  type HappierResolvedMenuGroup,
  type HappierResolvedPopoverPlacement,
  useHappierMenuInteraction,
} from '../presentation/interaction/Menu.js';
export {
  HappierMotionFeedback,
} from '../presentation/interaction/MotionFeedback.js';
export {
  HappierOptionRow,
  type HappierOptionRowControlProps,
  type HappierOptionRowProps,
  type HappierOptionRowStyles,
} from '../presentation/interaction/OptionRow.js';
export {
  type HappierPressableProps,
  type HappierPressableRole,
  type HappierPressableState,
  type HappierPressableStyleState,
} from '../presentation/interaction/Pressable.js';
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
} from '../presentation/interaction/ReleasePreview.js';
export {
  HappierSelectionActionBar,
  resolveHappierSelectionActionBarLayout,
  type HappierSelectionActionBarAction,
  type HappierSelectionActionBarHost,
  type HappierSelectionActionBarLayout,
  type HappierSelectionActionBarOverflowItem,
  type HappierSelectionActionBarProps,
} from '../presentation/interaction/SelectionActionBar.js';
export {
  HappierTextLinkButton,
  type HappierTextLinkButtonProps,
} from '../presentation/interaction/TextLinkButton.js';
export {
  clampCompanionPoint,
  pointIntersectsCompanionNoDragRegions,
  type CompanionDragBounds,
  type CompanionDragMotionPolicy,
  type CompanionPoint,
} from '../presentation/interaction/companionGeometry.js';
export {
  COMPANION_DRAG_THRESHOLD_PX,
  COMPANION_VELOCITY_MAX_MAGNITUDE_PX_PER_S,
  COMPANION_VELOCITY_MIN_MAGNITUDE_PX_PER_S,
  COMPANION_VELOCITY_MIN_SPAN_MS,
  COMPANION_VELOCITY_SAMPLE_WINDOW_MS,
} from '../presentation/interaction/companionPointerDragConfig.js';
export {
  projectCompanionRelease,
  resolveCompanionReleaseSpringConfig,
  type CompanionReleaseMotion,
  type CompanionReleaseSpringConfig,
} from '../presentation/interaction/companionReleaseMotion.js';
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
} from '../presentation/interaction/dragDrop.js';
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
} from '../presentation/interaction/dropOutcome.js';
export {
  HAPPIER_FOCUS_RING_DELEGATED_STYLE,
  HAPPIER_FOCUS_RING_V1,
  happierFocusRingStyle,
  isHappierFocusVisible,
  resolveHappierFocusRingVisible,
  type HappierFocusRingPlacement,
} from '../presentation/interaction/focusVisible.js';
export {
  HAPPIER_ICON_BUTTON_SIZE,
  resolveHappierIconButtonChrome,
  resolveHappierIconButtonRadius,
} from '../presentation/interaction/iconButtonChrome.js';
export {
  HAPPIER_MOTION_V1,
} from '../presentation/interaction/motion.js';
export {
  HAPPIER_PRESS_FEEDBACK_V1,
  happierPressTransitionStyle,
} from '../presentation/interaction/pressFeedback.js';
export {
  resolveCompanionDragVelocity,
  type CompanionDragVelocity,
  type CompanionDragVelocitySample,
} from '../presentation/interaction/resolveCompanionDragVelocity.js';
export {
  type CompanionPointerDragCoordinateSpace,
  type CompanionPointerDragEnd,
  type CompanionPointerDragMove,
  type CompanionPointerDragRelease,
  type CompanionPointerDragSelectors,
  type CompanionPointerDragStart,
  type CompanionPointerId,
  type CompanionPointerListenerHost,
  type UseCompanionPointerDragSessionParams,
  useCompanionPointerDragSession,
} from '../presentation/interaction/useCompanionPointerDragSession.js';
export {
  HappierColumn,
  HappierColumns,
  type HappierColumnProps,
  type HappierColumnsProps,
} from '../presentation/layout/Columns.js';
export {
  HAPPIER_FLOATING_FRAME_METRICS,
  resolveFloatingFrameBodyRect,
  resolveFloatingFrameChromeHeight,
  resolveFloatingFrameCorner,
  resolveFloatingFrameCornerRect,
  resolveFloatingFrameHeight,
  resolveFloatingFramePlacementStyle,
  resolveFloatingFrameSettleTransition,
  type FloatingFrameChromeOptions,
  type FloatingFrameCorner,
  type FloatingFrameRectChange,
  type HappierFloatingFrameNativeBindingProps,
  type HappierFloatingFramePointerBinding,
} from '../presentation/layout/FloatingFrame.js';
export {
  FloatingFramePicture,
  type FloatingFramePictureProps,
} from '../presentation/layout/FloatingFramePicture.js';
export {
  HappierScreen,
  HappierScrollArea,
  resolveHappierLayoutGap,
  type HappierLayoutGap,
  type HappierLayoutSpacing,
  type HappierScreenProps,
  type HappierScrollAreaProps,
  type HappierStackProps,
} from '../presentation/layout/Layout.js';
export {
  HappierPageHeader,
  type HappierPageHeaderBackRender,
  type HappierPageHeaderMetaFact,
  type HappierPageHeaderProps,
  type HappierPageHeaderTextRender,
} from '../presentation/layout/PageHeader.js';
export {
  HappierPageSectionContext,
  HappierPageSectionHeader,
  HappierPageSheet,
  HappierPageSheetGroup,
  happierPageRowDividerWidth,
  happierPageSheetShape,
  type HappierPageSection,
  type HappierPageSectionHeaderProps,
  type HappierPageSectionTextRender,
  type HappierPageSheetGroupProps,
  type HappierPageSheetProps,
  useHappierPageSection,
  withHappierPageSectionDividers,
} from '../presentation/layout/PageSection.js';
export {
  HappierMaterialRoleProvider,
  HappierSurface,
  type HappierFloatingRole,
  type HappierMaterialSurfaceRender,
  type HappierSurfaceProps,
  useContainingHappierMaterialRole,
  useHappierMaterialColorResolver,
} from '../presentation/layout/Surface.js';
export {
  HappierSurfaceGradientLayer,
} from '../presentation/layout/SurfaceGradientLayer.js';
export {
  HAPPIER_WIDGET_FRAME_METRICS,
  HAPPIER_WIDGET_FRAME_STYLES,
  HappierWidgetFrame,
  isHappierWidgetFrameSourceDescriptor,
  isHappierWidgetFrameSourceShown,
  resolveHappierWidgetFrameInsetPx,
  resolveHappierWidgetFrameSource,
  resolveHappierWidgetFrameSourceText,
  type HappierWidgetFramePlacement,
  type HappierWidgetFrameProps,
  type HappierWidgetFrameSourceBinding,
  type HappierWidgetFrameSourceDescriptor,
  type HappierWidgetFrameStyle,
  type HappierWidgetFrameTextRender,
  type HappierWidgetFrameTextRole,
} from '../presentation/layout/WidgetFrame.js';
export {
  HappierWidgetGlanceRow,
  type HappierWidgetGlanceRowColors,
  type HappierWidgetGlanceRowProps,
  type HappierWidgetGlanceRowSpace,
  type HappierWidgetGlanceRowTextProps,
} from '../presentation/layout/WidgetGlanceRow.js';
export {
  WidgetSizePicker,
  type WidgetSizePickerChoice,
  type WidgetSizePickerCompactInput,
  type WidgetSizePickerProps,
} from '../presentation/layout/WidgetSizePicker.js';
export {
  HAPPIER_COLUMN_GAP_PX,
  HAPPIER_COLUMN_MIN_WIDTH_PX,
  HAPPIER_COLUMN_ROW_GAP_PX,
  resolveHappierColumnCountForWidth,
} from '../presentation/layout/columnLayout.js';
export {
  frameRectsOverlap,
  type FloatingFrameGeometry,
  type FloatingFrameMode,
} from '../presentation/layout/floatingFrameGeometry.js';
export {
  happierMaterialBackgroundColor,
  happierMaterialGradient,
  happierMaterialInnerBackgroundColor,
  happierSurfaceFinishLift,
  happierSurfaceGradientWebStyle,
  resolveHappierSurfaceFinish,
  type HappierMaterialRole,
  type HappierSurfaceFinishRole,
  type HappierSurfaceGradient,
} from '../presentation/layout/material.js';
export {
  useHappierPageChrome,
} from '../presentation/layout/pageChrome.js';
export {
  HAPPIER_PAGE_ADAPTIVE_ACCESSORY_MAX_ROW_SHARE,
  HAPPIER_PAGE_METRICS,
  isHappierPageRowAccessoryStacked,
  isHappierPageRowNarrow,
  resolveHappierPageBackPlacement,
  type HappierCollectionRailWidth,
  type HappierPageBackPlacement,
} from '../presentation/layout/pageMetrics.js';
export {
  normalizeHappierPageOperations,
  readHappierPageOperation,
  type HappierPageOperation,
  type HappierPageOperationTextResolver,
} from '../presentation/layout/pageOperations.js';
export {
  HappierPageRowFieldLayoutContext,
  type HappierPageRowFieldLayout,
} from '../presentation/layout/pageRowField.js';
export {
  HAPPIER_PAGE_ROW_TOUCH_MIN_HEIGHT_PX,
  HAPPIER_ROW_TITLE_META_GAP_PX,
  resolveHappierPageRowDensityInput,
  resolveHappierPageRowMetrics,
  type HappierPageRowDensity,
  type HappierPageRowMetrics,
  type HappierPageRowShape,
} from '../presentation/layout/pageRowMetrics.js';
export {
  HAPPIER_PAGE_TEXT,
  happierPageTextMetrics,
  resolveHappierPageTextStyle,
  resolveHappierTextStepStyle,
  type HappierPageTextRole,
  type HappierPageTextStep,
  type HappierPageTextWeight,
} from '../presentation/layout/pageText.js';
export {
  HAPPIER_RAISED_EDGE_SIDE,
  happierRaisedEdgeStyle,
  resolveHappierGloss,
  resolveHappierRaisedEdge,
  settleHappierRaisedEdge,
  type HappierRaisedEdge,
  type HappierRaisedEdgeSide,
  type HappierRaisedEdgeState,
} from '../presentation/layout/raisedEdge.js';
export {
  HAPPIER_VIEWPORT_CLASS_MIN_EDGE_BREAKPOINTS_PX,
  resolveHappierViewportClass,
  resolveHappierViewportMinEdgePx,
  type HappierViewportClass,
} from '../presentation/layout/viewportClass.js';
export {
  HappierLiveStream,
  type HappierLiveStreamProps,
} from '../presentation/media/LiveStream.js';
export {
  type HappierLiveStreamGestureGeometry,
  type HappierLiveStreamInputControlKind,
  type HappierLiveStreamInputGesture,
  type HappierLiveStreamOrientation,
  type HappierLiveStreamPoint,
  type HappierLiveStreamRect,
} from '../presentation/media/inputGesture.js';
export {
  HappierBreadcrumb,
  type HappierBreadcrumbItem,
  type HappierBreadcrumbProps,
} from '../presentation/navigation/Breadcrumb.js';
export {
  HappierTabMarker,
  HappierTabs,
  isHappierTabSelected,
  resolveHappierTabKeySelection,
  type HappierTabDescriptor,
  type HappierTabPanelActivity,
  type HappierTabRetention,
  useHappierTabPanelActivity,
} from '../presentation/navigation/Tabs.js';
export {
  HAPPIER_TREE_ROW_METRICS,
  HappierTreeDisclosure,
  HappierTreeRow,
  resolveHappierTreeRowIndentPx,
  type HappierTreeRowActionsControl,
  type HappierTreeRowProps,
} from '../presentation/navigation/TreeRow.js';
export {
  resolveHappierTreeKeyIntent,
  type HappierTreeInteraction,
  type HappierTreeKeyIntent,
  useHappierTreeInteraction,
} from '../presentation/navigation/treeInteraction.js';
export {
  type HappierFocusable,
  type HappierLayoutChangeEvent,
  type HappierStyleProp,
  type HappierTextSelection,
} from '../presentation/portableTypes.js';
export {
  HAPPIER_TONE_COLOR_TOKEN,
  type HappierTextVariant,
  type HappierTone,
} from '../presentation/semantics.js';
export {
  HappierLinkDelivery,
  type HappierLinkDeliveryBindings,
  type HappierLinkDeliveryButtonProps,
  type HappierLinkDeliveryProps,
} from '../presentation/sharing/LinkDelivery.js';
export {
  HappierShareGrantRow,
  HappierShareLevelControl,
  HappierShareRowAction,
  type HappierShareAction,
  type HappierShareChoiceProps,
  type HappierShareGrantRemoval,
  type HappierShareGrantRowProps,
  type HappierShareHost,
  type HappierShareLevelControlProps,
  type HappierShareRowActionProps,
  type HappierShareTextProps,
} from '../presentation/sharing/ShareGrantRow.js';
export {
  HappierShareHelp,
  HappierShareSheet,
  type HappierShareHelpProps,
  type HappierShareSheetButtonProps,
  type HappierShareSheetProps,
} from '../presentation/sharing/ShareSheet.js';
export {
  HAPPIER_EMPTY_SLOT_METRICS,
  HappierEmptySlot,
  type HappierEmptySlotColors,
  type HappierEmptySlotProps,
} from '../presentation/state/EmptySlot.js';
export {
  HAPPIER_EMPTY_STATE_FRAME,
  HAPPIER_FRESHNESS_LINE_METRICS,
  HAPPIER_STATE_LINE_METRICS,
  HAPPIER_STATE_SIZE_METRICS,
  HappierFreshnessLine,
  HappierFreshnessClauses,
  HappierInfoState,
  HappierInfoTile,
  HappierStateDetails,
  HappierSurfaceStateFrame,
  resolveHappierStateAnnouncement,
  resolveHappierStateFailureGlyph,
  type HappierInfoStateProps,
  type HappierInfoTileProps,
  type HappierStateSize,
  type HappierSurfaceStateKind,
} from '../presentation/state/InfoState.js';
export {
  HappierSurfaceState,
  HappierSurfaceStateLiveLine,
  resolveHappierSurfaceStateQuiet,
  type HappierSurfaceStateAction,
  type HappierSurfaceStateBindings,
  type HappierSurfaceStateLive,
  type HappierSurfaceStateProps,
  type HappierSurfaceStateQuietMetrics,
  type HappierSurfaceStateSize,
  type HappierSurfaceStateTextRole,
} from '../presentation/state/SurfaceState.js';
export {
  formatHappierAsOfTime,
  resolveHappierFreshnessText,
  type HappierFreshnessTextParts,
} from '../presentation/state/asOfTime.js';
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
} from '../presentation/state/scenes.js';
export {
  HAPPIER_CONTROL_CAPSULE_BUTTON_SIZE,
  HAPPIER_CONTROL_CAPSULE_METRICS,
  HappierControlCapsule,
  type HappierControlCapsuleProps,
} from '../presentation/status/ControlCapsule.js';
export {
  HappierStatus,
  type HappierStatusProps,
} from '../presentation/status/Status.js';
export {
  HAPPIER_REVIEW_SEVERITY_METRICS,
  HAPPIER_REVIEW_SEVERITY_RANK,
  HAPPIER_REVIEW_SEVERITY_TONE,
  HappierReviewSeveritySign,
  resolveHappierReviewSeverityColor,
  type HappierReviewSeverity,
  type HappierReviewSeveritySignProps,
} from '../presentation/status/ReviewSeverity.js';
export {
  HappierIdentityCapsule,
  HappierStatusCapsule,
  type HappierIdentityCapsuleProps,
  type HappierStatusCapsuleProps,
} from '../presentation/status/StatusCapsule.js';
export {
  HappierStatusDot,
  type HappierStatusDotProps,
} from '../presentation/status/StatusDot.js';
export {
  type HappierCapsuleButtonEmphasis,
  type HappierCapsuleColors,
  type HappierCapsuleHost,
  type HappierSurfaceGlyph,
  type HappierSurfaceGlyphRenderer,
} from '../presentation/status/capsuleHost.js';
export {
  HappierTextSelectabilityScope,
  type HappierTextPresentation,
  type HappierTextPresentationInput,
  type HappierTextProps,
  type HappierTextSelectabilityScopeProps,
  useHappierTextPresentation,
} from '../presentation/text/Text.js';
export {
  HAPPIER_META_COLUMN_STYLE,
  HAPPIER_META_COLUMN_V1,
} from '../presentation/text/metaColumn.js';
export {
  cloneStyleEntryPreservingOwnProps,
  scaleTextStyleMetrics,
  type ScaleTextStyleOptions,
  type ScaledTextStyleMetrics,
  type TextStyleEntryTransform,
} from '../presentation/text/textStyleScale.js';
export {
  HAPPIER_TYPE_SCALE,
  HAPPIER_TYPE_WEIGHT,
  resolveHappierTypeScale,
  type HappierTypeEmphasis,
  type HappierTypeRole,
  type HappierTypeScaleStep,
} from '../presentation/text/typeScale.js';
export {
  HappierFactLine,
  joinHappierFacts,
  type HappierFactLineProps,
} from '../presentation/work/FactLine.js';
export {
  HappierProvenanceChip,
  type HappierProvenanceChipProps,
} from '../presentation/work/ProvenanceChip.js';
export {
  HappierRoleMark,
} from '../presentation/work/RoleMark.js';
export {
  HappierTriggerRow,
  type HappierTriggerRowBodyProps,
  type HappierTriggerRowHost,
  type HappierTriggerRowProps,
  type HappierTriggerRowToggleProps,
} from '../presentation/work/TriggerRow.js';
export {
  HAPPIER_WORK_MAP_LANE_MIN_WIDTH,
  HappierWorkMapView,
  type HappierWorkMapDensity,
  type HappierWorkMapNodeAppearance,
  type HappierWorkMapNodePresentation,
  type HappierWorkMapViewProps,
} from '../presentation/work/WorkMapView.js';
export {
  HAPPIER_WORK_PAGE_ROW_METRICS,
  HappierWorkRowShell,
  HappierWorkStatusWord,
  HappierWorkSummary,
  type HappierWorkRowDensity,
  type HappierWorkRowShellProps,
  type HappierWorkSummaryPhase,
  type HappierWorkSummaryProps,
} from '../presentation/work/WorkRow.js';
export {
  HappierWorkDisclosureLine,
  HappierWorkFlatSheet,
  HappierWorkSection,
  HappierWorkSectionEmptyLine,
  type HappierWorkDisclosureLineProps,
  type HappierWorkSectionEmptyLineProps,
  type HappierWorkSectionProps,
} from '../presentation/work/WorkSection.js';
export {
  HAPPIER_WORK_UPDATE_CARD_FACT_ICON_SIZE_PX,
  HAPPIER_WORK_UPDATE_CARD_MARK_SIZE_PX,
  HappierWorkUpdateCard,
  type HappierWorkUpdateCardFact,
  type HappierWorkUpdateCardProps,
  type HappierWorkUpdateCardSurface,
} from '../presentation/work/WorkUpdateCard.js';
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
} from '../presentation/work/workMap.js';
export {
  HAPPIER_WORK_STATUS_BUCKETS,
  HAPPIER_WORK_STATUS_BUCKET_LABEL_KEYS,
  HAPPIER_WORK_STATUS_SEMANTIC_TONE,
  resolveHappierWorkStatusBucketLabel,
  resolveHappierWorkStatusGlyphColor,
  resolveHappierWorkStatusSurfaceStyle,
  resolveHappierWorkStatusWordColor,
  type CollectionGroupRollup,
  type HappierWorkStateColors,
  type HappierWorkStatusBucket,
  type HappierWorkStatusColors,
  type HappierWorkStatusPresentation,
  type HappierWorkStatusTone,
} from '../presentation/work/workStatus.js';
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
} from '../presentation/work/workTheme.js';
export {
  HAPPIER_WORK_KIND_GLYPHS,
  resolveHappierRoleGlyph,
  resolveHappierRoleRunsAsPresentation,
  resolveHappierWorkKindPresentation,
  type HappierRoleRunsAsKind,
  type HappierWorkKind,
} from '../presentation/work/workVocabulary.js';
export {
  CapabilityBlockingBanner,
  CapabilityDetailHeader,
  CapabilityFacts,
  CapabilityStatusChip,
  WhereItsOnControl,
  capabilityCollectionAnatomy,
  type CapabilityBlockingBannerProps,
  type CapabilityCollectionAnatomyInput,
  type CapabilityCost,
  type CapabilityDetailHeaderProps,
  type CapabilityFactsInput,
  type CapabilityFactsProps,
  type CapabilityFixKind,
  type CapabilitySource,
  type CapabilityStatus,
  type CapabilityStatusChipProps,
  type CapabilityStatusKind,
  type CapabilityStatusPlacement,
  type CapabilityTrust,
  type WhereItsOnControlProps,
  type WhereItsOnIntent,
  type WhereItsOnIntentResult,
  type WhereItsOnPlace,
  type WhereItsOnRule,
} from './Capabilities.js';
export {
  CapabilityAddBody,
  type CapabilityAddBodyProps,
  type CapabilityAddConfig,
  type CapabilityAddDetailFooter,
  type CapabilityAddFound,
  type CapabilityAddLevel,
  type CapabilityAddMode,
} from './CapabilityAddBody.js';
/** The most blocking capability status that speaks at a placement; null when none does (healthy is quiet). */
export { pickMostBlockingHappierCapabilityStatus as pickMostBlockingCapabilityStatus } from '../presentation/capabilities/capabilityStatus.js';
export {
  HAPPIER_COLLECTION_ROW_METRICS,
  HappierCollectionRowContent,
  resolveHappierCollectionRowHeight,
  resolveHappierCollectionRowIdentityMetrics,
  resolveHappierCollectionRowLineMetrics,
  resolveHappierCollectionRowTitleMetrics,
  type HappierCollectionRowContentProps,
  type HappierCollectionRowDensity,
  type HappierCollectionRowTextMetrics,
} from '../presentation/collection/CollectionRowContent.js';
export { Checkbox, type CheckboxProps, type CheckboxSize } from './Checkbox.js';
