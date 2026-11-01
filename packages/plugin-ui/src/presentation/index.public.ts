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
  HappierFocusable,
  HappierLayoutChangeEvent,
  HappierStyleProp,
  HappierTextSelection,
} from './portableTypes.js';
export { HappierRowOperationContext } from './collection/rowOperation.js';
export {
  HappierCollectionAddMenu,
  COLLECTION_ADD_MENU_SEARCH_THRESHOLD,
  type CollectionAddMenuItem,
  type HappierCollectionAddMenuHost,
  type HappierCollectionAddMenuProps,
} from './collection/CollectionAddMenu.js';
export {
  HappierItemAddRow,
  type HappierItemAddRowContentProps,
  type HappierItemAddRowRenderProps,
  type HappierItemAddRowProps,
} from './collection/ItemAddRow.js';
export { resolveHappierPageRowDetailLayout } from './layout/pageRowDetail.js';
export * from './work/workVocabulary.js';
export * from './layout/resize/useResizableSize.js';
export * from './layout/resize/HappierResizeHandle.js';
export * from './layout/resize/resolvePointerClientPoint.js';
export { COLLECTION_RAIL_MIN_WIDTH_PX } from './collection/CollectionList.js';
export { HappierRoleMark } from './work/RoleMark.js';
export {
  HappierDecisionBar,
  type HappierDecisionAction,
  type HappierDecisionButtonProps,
  type HappierDecisionBarProps,
} from './interaction/DecisionBar.js';
export * from './interaction/companionReleaseMotion.js';
export { HappierMotionFeedback, type MotionFeedbackProps } from './interaction/MotionFeedback.js';
export { useHappierCopyFeedback } from './interaction/copyFeedback.js';
export { HappierComposerChip, type HappierComposerChipProps } from './interaction/ComposerChip.js';
export {
  HappierApprovalPromptChrome,
  type HappierApprovalPromptChromeProps,
  type HappierApprovalPromptTextRender,
} from './interaction/ApprovalPromptChrome.js';
export {
  HappierApprovalPendingNotice,
  HappierNoticeLine,
  type HappierApprovalPendingNoticeProps,
  type HappierApprovalPendingNoticeTextRender,
  type HappierNoticeLineProps,
  type HappierNoticeLineTextRender,
} from './interaction/ApprovalPendingNotice.js';
export {
  HAPPIER_APPROVAL_FIELDS_METRICS,
  HappierApprovalFieldEntries,
  HappierApprovalFields,
  type HappierApprovalFieldEntriesProps,
  type HappierApprovalFieldEntry,
  type HappierApprovalFieldResolve,
  type HappierApprovalFieldRow,
  type HappierApprovalFieldsColors,
  type HappierApprovalFieldsLook,
  type HappierApprovalFieldsProps,
  type HappierApprovalFieldsSpace,
  type HappierApprovalFieldsTextRender,
  type HappierApprovalFieldsTextRole,
} from './interaction/ApprovalFields.js';
export * from './interaction/companionPointerDragConfig.js';
export * from './interaction/resolveCompanionDragVelocity.js';
export * from './interaction/companionGeometry.js';
export * from './interaction/useCompanionPointerDragSession.js';
export {
  frameRectsOverlap,
  resolveFloatingFrameRect,
  resolveFloatingFrameResizeRect,
  type FrameRect,
  type FloatingFrameMode,
  type FloatingFrameGeometry,
} from './layout/floatingFrameGeometry.js';
export {
  FloatingFrame,
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
  type FloatingFrameProps,
  type FloatingFrameRectChange,
  type HappierFloatingFramePointerBinding,
  type HappierFloatingFrameNativeBindingProps,
} from './layout/FloatingFrame.js';
export {
  FloatingFramePicture,
  type FloatingFramePictureProps,
} from './layout/FloatingFramePicture.js';
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
  HappierTreeRow,
  resolveHappierTreeRowIndentPx,
  useHappierTreeRowLineHeight,
  type HappierTreeRowActionsControl,
  type HappierTreeRowProps,
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
export { HAPPIER_DROP_INDICATOR_METRICS, HappierDropInsertionLine, HappierDropTargetOutline } from './interaction/DropTargetOutline.js';
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
  type HappierSetupStepGlyphState,
  type HappierSetupStepState,
  type HappierSetupStepsProps,
  type HappierSetupStepsVariant,
  type HappierSetupStepTitlePresentation,
} from './content/SetupSteps.js';
export { HappierFieldStepper } from './form/FieldStepper.js';
export {
  HappierLocalDateTimeField,
  type HappierLocalDateTimeFieldProps,
  type HappierLocalDateTimePickerHost,
  type HappierLocalDateTimePickerMode,
  type HappierLocalDateTimePickerRequest,
} from './form/LocalDateTimeField.js';
export {
  formatHappierLocalDateInput,
  formatHappierLocalTimeInput,
  parseHappierLocalDateTime,
  resolveHappierFutureLocalDateTime,
  toHappierLocalDateTimeDraft,
  type HappierLocalDateTimeDraft,
} from './form/localDateTimeValue.js';
export type { HappierFieldStepperBounds } from './form/fieldValueDraft.js';
export {
  happierMaterialBackgroundColor,
  happierMaterialInnerBackgroundColor,
  happierMaterialGradient,
  happierSurfaceGradientWebStyle,
  happierSurfaceFinishLift,
  resolveHappierSurfaceFinish,
  type HappierSurfaceGradient,
  type HappierSurfaceFinishRole,
  type HappierMaterialRole,
} from './layout/material.js';
export { HappierSurfaceGradientLayer } from './layout/SurfaceGradientLayer.js';
export { happierSvgGradientStop } from './layout/svgGradientStop.js';
export { HappierMaterialRoleProvider, HappierOpenedLayer, useContainingHappierMaterialRole, useHappierMaterialColorResolver, type HappierFloatingRole, type HappierMaterialSurfaceRender } from './layout/Surface.js';
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
export { HappierImageCheckerboard } from './media/ImageBacking.js';
export { isHappierAlphaCapableImageMimeType } from './media/imageMimeAlpha.js';
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
  resolveHappierIconButtonRadius,
} from './interaction/iconButtonChrome.js';
export {
  HAPPIER_PAGE_ROW_TOUCH_MIN_HEIGHT_PX,
  resolveHappierPageRowMetrics,
  resolveHappierPageRowDensityInput,
  type HappierPageRowDensity,
  type HappierPageRowShape,
  type HappierPageRowMetrics,
  HAPPIER_ROW_TITLE_META_GAP_PX,
} from './layout/pageRowMetrics.js';
export {
  HappierListDetailLayout,
  type HappierListDetailLayoutProps,
  type HappierListDetailLayoutState,
} from './collection/ListDetailLayout.js';
export {
  HappierCollectionNavigationBackClosesDetailContext,
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
  type HappierCollectionTree,
  type HappierCollectionTreeNode,
  type HappierCollectionVisitMemory,
  type HappierCollectionWindow,
} from './collection/collectionModel.js';
export {
  rankHappierQueryMatches,
  type HappierQueryRankOptions,
  type HappierQueryText,
} from './collection/queryRank.js';
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
export { resolveHappierCollectionTitleAccessoryFits } from './collection/collectionTitleRoom.js';
export {
  HAPPIER_COLLECTION_LIST_METRICS,
  HAPPIER_COLLECTION_LIST_ROW_STYLE,
  HAPPIER_COLLECTION_LIST_TEXT,
  resolveHappierCollectionListRowPadding,
  resolveHappierCollectionTreeChildIndentPx,
  HappierCollectionList,
  HappierCollectionListGroupLabel,
  HappierCollectionListMark,
  HappierCollectionRestingRowsContext,
  useHappierCollectionDraftRowTitle,
  type HappierCollectionListFilters,
  type HappierCollectionListHost,
  type HappierCollectionListProps,
  type HappierCollectionListSearch,
  type HappierCollectionListTextRole,
  type HappierCollectionRestingRows,
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
  HappierCountedDisclosure,
  type HappierCountedDisclosureContentProps,
  type HappierCountedDisclosureFrameProps,
  type HappierCountedDisclosureHeaderState,
  type HappierCountedDisclosureProps,
} from './collection/CountedDisclosure.js';
export {
  HAPPIER_TECHNICAL_DETAILS_METRICS,
  HappierTechnicalDetailsDisclosure,
  type HappierTechnicalDetailsContentProps,
  type HappierTechnicalDetailsDisclosureProps,
  type HappierTechnicalDetailsLine,
  type HappierTechnicalDetailsSpace,
  type HappierTechnicalDetailsTextRender,
} from './collection/TechnicalDetailsDisclosure.js';
export {
  HappierListOverflowFooter,
  leadHappierListRows,
  type HappierListOverflowFooterLabels,
  type HappierListOverflowFooterProps,
} from './collection/ListOverflowFooter.js';
export {
  HAPPIER_DISCLOSURE_CHEVRON_METRICS,
  HappierChevron,
  HappierDisclosureChevron,
  HappierDisclosureTurn,
  type HappierChevronDirection,
} from './collection/DisclosureChevron.js';
export {
  HappierDisclosureToggle,
  type HappierDisclosureCaretDensity,
  type HappierDisclosureToggleProps,
} from './collection/DisclosureToggle.js';
export {
  HappierColumns,
  HappierColumn,
  type HappierColumnsProps,
  type HappierColumnProps,
} from './layout/Columns.js';
export {
  HAPPIER_PAGE_METRICS,
  isHappierPageRowNarrow,
  isHappierPageRowAccessoryStacked,
  HAPPIER_PAGE_ADAPTIVE_ACCESSORY_MAX_ROW_SHARE,
  resolveHappierPageBackPlacement,
  type HappierPageBackPlacement,
  type HappierCollectionRailWidth,
} from './layout/pageMetrics.js';
export {
  HAPPIER_VIEWPORT_CLASS_MIN_EDGE_BREAKPOINTS_PX,
  resolveHappierViewportClass,
  resolveHappierViewportMinEdgePx,
  type HappierViewportClass,
} from './layout/viewportClass.js';
export {
  HappierPageRowFieldLayoutContext,
  type HappierPageRowFieldLayout,
} from './layout/pageRowField.js';
export { resolveHappierPageRowFieldMaxWidth } from './collection/List.js';
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
  HAPPIER_MODAL_HEADER_METRICS,
  HappierModalHeader,
  resolveHappierModalHeaderLayout,
  type HappierModalHeaderLayout,
  type HappierModalHeaderProps,
  type HappierModalHeaderSpace,
  type HappierModalHeaderTextRender,
} from './layout/ModalHeader.js';
export {
  normalizeHappierPageOperations,
  readHappierPageOperation,
  splitHappierPagePrimaryOperation,
  type HappierPageOperation,
  type HappierPageOperationTextResolver,
} from './layout/pageOperations.js';
export { HappierColumnEdgeContext } from './layout/columnEdge.js';
export {
  HappierPageSectionContext,
  HappierPageSectionHeader,
  HappierPageSheet,
  HappierPageSheetGroup,
  happierPageRowDividerInset,
  happierPageRowDividerWidth,
  happierPageSheetShape,
  useHappierPageSection,
  withHappierPageSectionDividers,
  type HappierPageSection,
  type HappierPageSectionHeaderProps,
  type HappierPageSectionTextRender,
  type HappierPageSheetGroupProps,
  type HappierPageSheetColors,
  type HappierPageSheetProps,
} from './layout/PageSection.js';
export {
  HAPPIER_WIDGET_FRAME_METRICS,
  HAPPIER_WIDGET_FRAME_STYLES,
  HappierWidgetFrame,
  isHappierWidgetFrameSourceShown,
  isHappierWidgetFrameSourceDescriptor,
  resolveHappierWidgetFrameSource,
  resolveHappierWidgetFrameSourceText,
  type HappierWidgetFrameSourceBinding,
  type HappierWidgetFrameSourceDescriptor,
  resolveHappierWidgetFrameInsetPx,
  type HappierWidgetFramePlacement,
  type HappierWidgetFrameProps,
  type HappierWidgetFrameStyle,
  type HappierWidgetFrameTextRender,
  type HappierWidgetFrameTextRole,
} from './layout/WidgetFrame.js';
export {
  packWidgetGroupBands,
  resolveWidgetGroupColumns,
  type WidgetGroupBand,
  type WidgetGroupCell,
  type WidgetGroupCellInput,
  type WidgetGroupContentState,
} from './layout/widgetGroupLayout.js';
export {
  HAPPIER_PUBLIC_PROFILE_HERO_METRICS,
  resolveHappierPublicProfilePlanetBand,
  HappierPublicProfile,
  HappierPublicProfileWidget,
  type HappierPublicProfileBrand,
  type HappierPublicProfileHeroGeometry,
  type HappierPublicProfileLabels,
  type HappierPublicProfileOwner,
  type HappierPublicProfileProps,
} from './account/PublicProfile.js';
export type {
  HappierPublicProfileUsageHost,
  HappierPublicProfileUsageLabels,
  PublicUsageOriginalLabels,
  PublicUsageMetricId,
} from './account/PublicProfileUsage.js';
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
  useHappierTextSelectability,
  type HappierTextProps,
  type HappierTextPresentation,
  type HappierTextPresentationInput,
  type HappierTextSelectabilityScopeProps,
} from './text/Text.js';
export {
  HAPPIER_META_COLUMN_STYLE,
  HAPPIER_META_COLUMN_V1,
} from './text/metaColumn.js';
export { HAPPIER_MIDDLE_ELLIPSIS_STYLE, splitForWebMiddleEllipsis } from './text/middleEllipsis.js';
export { HAPPIER_BALANCED_TEXT_WRAP } from './text/balancedTextWrap.js';
export { HAPPIER_TYPE_SCALE, HAPPIER_TYPE_WEIGHT, resolveHappierTypeScale, type HappierTypeRole, type HappierTypeEmphasis, type HappierTypeScaleStep } from './text/typeScale.js';
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
  HappierSkeletonPulse,
  HappierSkeletonRows,
  type HappierSkeletonBlockProps,
  type HappierSkeletonPulseProps,
  type HappierSkeletonRowsProps,
  type HappierSkeletonRowGeometry,
} from './feedback/Skeleton.js';
export {
  HappierStatusDot,
  type HappierStatusDotProps,
} from './status/StatusDot.js';
export { HappierStatus, type HappierStatusProps } from './status/Status.js';
export {
  HAPPIER_REVIEW_SEVERITY_METRICS,
  HAPPIER_REVIEW_SEVERITY_RANK,
  HAPPIER_REVIEW_SEVERITY_TONE,
  HappierReviewSeveritySign,
  resolveHappierReviewSeverityColor,
  type HappierReviewSeverity,
  type HappierReviewSeveritySignProps,
} from './status/ReviewSeverity.js';
export {
  HappierRowActionRevealSlot,
  type HappierRowActionRevealSlotProps,
} from './collection/RowActionRevealSlot.js';
export {
  HappierDiffStat,
  formatHappierDiffStat,
  type HappierDiffStatKind,
  type HappierDiffStatProps,
  type HappierDiffStatTextProps,
} from './content/DiffStat.js';
export {
  HAPPIER_INLINE_CODE_METRICS,
  HappierInlineCode,
  type HappierInlineCodeProps,
  type HappierInlineCodeTextProps,
} from './text/InlineCode.js';
export {
  HappierWidgetGlanceRow,
  type HappierWidgetGlanceRowColors,
  type HappierWidgetGlanceRowProps,
  type HappierWidgetGlanceRowSpace,
  type HappierWidgetGlanceRowTextProps,
} from './layout/WidgetGlanceRow.js';
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
export { formatHappierDataBytes, formatHappierDataBytesParts, type HappierDataBytesKind } from './data/dataModel.js';
export { HAPPIER_SERIES_RAMP_ALPHAS, mixHappierColorOverPaper, resolveHappierSeriesRampColor } from './data/dataModel.js';
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
export { CapacityBar, type CapacityBarProps } from './data/CapacityBar.js';
export { RankedRows, type RankedRowsProps } from './data/RankedRows.js';
export { CompositionStrip, type CompositionStripProps, type CompositionSegment } from './data/CompositionStrip.js';
export { StackedSeriesChart, type StackedSeriesChartProps, type StackedSeriesBand } from './data/StackedSeriesChart.js';
export { CoreLoadBars, type CoreLoadBarsProps, type CoreLoadBar } from './data/CoreLoadBars.js';
// Whole-disk Storage chart forms (plan 40 §4.11): Map (squarified treemap) and Rings (sunburst) with their pure layouts.
export { Treemap, type HappierChartPart, type HappierTreemapProps } from './data/Treemap.js';
export { Sunburst, type HappierSunburstProps } from './data/Sunburst.js';
export { layoutHappierTreemap, squarifyHappierTreemap, createHappierTreemapHitGrid, HAPPIER_TREEMAP_SMALLER_SUFFIX,
  type HappierTreemapNode, type HappierTreemapTile, type HappierTreemapRect, type HappierTreemapLayoutOptions } from './data/treemapLayout.js';
export { layoutHappierSunburst, hitHappierSunburst, HAPPIER_SUNBURST_SMALLER_SUFFIX,
  type HappierSunburstNode, type HappierSunburstArc, type HappierSunburstRing, type HappierSunburstLayoutOptions } from './data/sunburstLayout.js';
export { BurnUpChart, type BurnUpChartProps } from './data/BurnUpChart.js';
export { Heatmap, resolveFirstFullyVisibleColumn, type HeatmapProps, type HappierGridAxis, type HappierGridCell, type HappierGridFrame } from './data/Heatmap.js';
export { DotGrid, type DotGridProps } from './data/DotGrid.js';
export { IntervalTimeline, type IntervalTimelineProps, type IntervalTimelineInterval } from './data/IntervalTimeline.js';
export { OutcomeScatter, type OutcomeScatterProps, type OutcomeScatterPoint, type OutcomeScatterGuide } from './data/OutcomeScatter.js';
export { OutcomeFunnel, type OutcomeFunnelProps, type OutcomeFunnelStep } from './data/OutcomeFunnel.js';
export { describeHappierSeriesBucket, type HappierSeries, type HappierSeriesPoint, type HappierSeriesBucket } from './data/dataModel.js';
export type {
  HappierCapsuleButtonEmphasis,
  HappierCapsuleColors,
  HappierCapsuleHost,
  HappierSurfaceGlyph,
  HappierSurfaceGlyphRenderer,
} from './status/capsuleHost.js';
export {
  HappierIdentityCapsule,
  HappierStatusCapsule,
  type HappierIdentityCapsuleProps,
  type HappierStatusCapsuleProps,
} from './status/StatusCapsule.js';
export {
  HAPPIER_COMPOSER_STATUS_BADGE_METRICS,
  HAPPIER_COMPOSER_STATUS_BADGE_TYPE,
  HappierComposerStatusBadge,
  resolveHappierComposerStatusState,
  type HappierComposerStatusBadgeProps,
  type HappierComposerStatusEmphasis,
  type HappierComposerStatusState,
  type HappierComposerStatusTone,
} from './status/ComposerStatusBadge.js';
export {
  HAPPIER_CONTROL_CAPSULE_BUTTON_SIZE,
  HAPPIER_CONTROL_CAPSULE_METRICS,
  HappierControlCapsule,
  type HappierControlCapsuleProps,
} from './status/ControlCapsule.js';
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
export {
  HAPPIER_PROMPT_PICKER_METRICS,
  HappierPromptPickerMetaLine,
  HappierPromptPickerPreview,
  HappierPromptPickerRow,
  type HappierPromptPickerColors,
  type HappierPromptPickerHost,
  type HappierPromptPickerMetaPart,
} from './prompts/PromptPicker.js';
export type {
  FindCapabilities,
  FindController,
  FindCoverage,
  FindOptions,
  FindStatus,
  FindTextRange,
} from './find/findTypes.js';
export type { FindSurfaceRegistration } from './find/useFindSurfaceRegistration.js';
export { HappierFindHighlightedText, sliceFindRanges, type FindMarkStyle, type HappierFindHighlightedTextProps } from './find/FindHighlightedText.js';
export {
  HappierPressable,
  type HappierPressableProps,
  type HappierPressableRole,
  type HappierPressableState,
  type HappierPressableStyleState,
} from './interaction/Pressable.js';
export { useHappierHitArea } from './interaction/hitArea.js';
export { HappierTextLinkButton, type HappierTextLinkButtonProps } from './interaction/TextLinkButton.js';
export {
  HAPPIER_FOCUS_RING_DELEGATED_STYLE,
  HAPPIER_TEXT_INPUT_FOCUS_RESET_STYLE,
  HAPPIER_TEXT_INPUT_WEB_MARKER,
  HAPPIER_FOCUS_RING_V1,
  happierFocusRingStyle,
  isHappierFocusVisible,
  resolveHappierFocusRingVisible,
  type HappierFocusRingPlacement,
} from './interaction/focusVisible.js';
export {
  resolveHappierMenuKeyAction,
  HAPPIER_MENU_ROW_METRICS,
  HAPPIER_MENU_ROW_TEXT,
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
export { HappierOptionRow, type HappierOptionRowProps, type HappierOptionRowStyles, type HappierOptionRowControlProps } from './interaction/OptionRow.js';
export {
  HAPPIER_EMPTY_SLOT_METRICS,
  HappierEmptySlot,
  type HappierEmptySlotColors,
  type HappierEmptySlotProps,
} from './state/EmptySlot.js';
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
  HappierFreshnessClauses,
  resolveHappierStateAnnouncement,
  resolveHappierStateFailureGlyph,
  type HappierSurfaceStateKind,
  type HappierInfoStateProps,
  type HappierInfoTileProps,
  type HappierStateSize,
} from './state/InfoState.js';
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
} from './state/SurfaceState.js';
export {
  formatHappierAsOfTime,
  resolveHappierFreshnessText,
  type HappierFreshnessTextParts,
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
  useHappierItemOverflowState,
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
  splitHappierBannerPoint,
  type HappierBannerPoint,
  type HappierMetadataEntry,
} from './content/Foundation.js';
export { HappierStep, HappierStepMarkerView } from './content/Step.js';
export {
  HappierMarkdown,
  type HappierMarkdownProps,
  type HappierMarkdownRenderInput,
  type MarkdownInlineReference,
  type MarkdownInlineReferences,
  type MarkdownImageSource,
  type MarkdownImageResolver,
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
  planHappierSelectOptions,
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
  HAPPIER_SEGMENTED_CHOICES_MAX,
  HAPPIER_SEGMENTED_LABEL_MAX_CHARS,
  resolveHappierActionFieldPresentation,
  resolveHappierChoiceControl,
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
} from './form/SelectionTiles.js';
export {
  HappierTabs,
  HappierTabMarker,
  isHappierTabSelected,
  resolveHappierTabGlyphOnly,
  resolveHappierTabKeySelection,
  useHappierTabPanelActivity,
  type HappierTabDescriptor,
  type HappierTabLabels,
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
  type HappierFieldTextPresentation,
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
  HappierSegmentedChoiceRow,
  resolveHappierSegmentedChoiceRow,
  type HappierSegmentedChoiceRowColors,
  type HappierSegmentedChoiceRowModel,
  type HappierSegmentedChoiceRowOption,
  type HappierSegmentedChoiceRowProps,
} from './form/SegmentedChoiceRow.js';
export {
  HAPPIER_RADIO_MARK_METRICS,
  HappierRadioMark,
} from './form/RadioMark.js';
export {
  HAPPIER_RADIO_CHOICE_LIST_METRICS,
  HappierRadioChoiceList,
  type HappierRadioChoiceOption,
} from './form/RadioChoiceList.js';
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
  type CollectionGroupRollup,
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
  HappierWorkSectionEmptyLine,
  HappierWorkDisclosureLine,
  type HappierWorkSectionProps,
  type HappierWorkSectionEmptyLineProps,
  type HappierWorkDisclosureLineProps,
} from './work/WorkSection.js';
export { HappierFactLine, joinHappierFacts, type HappierFactLineProps } from './work/FactLine.js';
export { HappierBreadcrumb, type HappierBreadcrumbItem, type HappierBreadcrumbProps } from './navigation/Breadcrumb.js';
export {
  HAPPIER_WORK_PAGE_ROW_METRICS,
  HappierWorkRowShell,
  HappierWorkStatusWord,
  HappierWorkSummary,
  type HappierWorkRowShellProps,
  type HappierWorkSummaryPhase,
  type HappierWorkSummaryProps,
  type HappierWorkRowDensity,
} from './work/WorkRow.js';
export {
  HAPPIER_WORK_UPDATE_CARD_FACT_ICON_SIZE_PX,
  HAPPIER_WORK_UPDATE_CARD_MARK_SIZE_PX,
  HappierWorkUpdateCard,
  type HappierWorkUpdateCardFact,
  type HappierWorkUpdateCardProps,
  type HappierWorkUpdateCardSurface,
} from './work/WorkUpdateCard.js';
export { HappierTriggerRow, type HappierTriggerRowProps, type HappierTriggerRowHost, type HappierTriggerRowBodyProps, type HappierTriggerRowToggleProps } from './work/TriggerRow.js';
export { HappierProvenanceChip, type HappierProvenanceChipProps } from './work/ProvenanceChip.js';
export {
  HappierShareRowAction, HappierShareLevelControl, HappierShareGrantRow,
  type HappierShareAction, type HappierShareChoiceProps, type HappierShareHost, type HappierShareTextProps,
  type HappierShareRowActionProps, type HappierShareLevelControlProps,
  type HappierShareGrantRemoval, type HappierShareGrantRowProps,
} from './sharing/ShareGrantRow.js';
export {
  HappierShareSheet, HappierShareHelp,
  type HappierShareSheetProps, type HappierShareSheetButtonProps, type HappierShareHelpProps,
} from './sharing/ShareSheet.js';
export {
  HAPPIER_SETTING_INPUT_STYLE,
  HAPPIER_SETTING_VALUE_SLOT_METRICS,
  HappierSettingStatusLine,
  HappierSettingValueSlot,
  type HappierSettingRowLayout,
  type HappierSettingStatusLineProps,
  type HappierSettingValueSlotProps,
} from './form/SettingField.js';
export {
  HappierLinkDelivery,
  type HappierLinkDeliveryBindings,
  type HappierLinkDeliveryButtonProps,
  type HappierLinkDeliveryProps,
} from './sharing/LinkDelivery.js';
export * from './usage/charts/index.js';
export {
  doesHappierCapabilityStatusSpeak,
  pickMostBlockingHappierCapabilityStatus,
  presentHappierCapabilityStatus,
  resolveHappierCapabilityBlockingNotice,
  type HappierCapabilityFixKind,
  type HappierCapabilityStatus,
  type HappierCapabilityStatusKind,
  type HappierCapabilityStatusLabels,
  type HappierCapabilityStatusPlacement,
  type HappierCapabilityStatusPresentation,
  type HappierCapabilityStatusTone,
  type HappierCapabilityStatusVariant,
} from './capabilities/capabilityStatus.js';
export {
  HappierCapabilityStatusChip,
  type HappierCapabilityStatusChipProps,
  type HappierCapabilityStatusFixProps,
  type HappierCapabilityStatusPillProps,
} from './capabilities/CapabilityStatusChip.js';
export {
  HappierCapabilityFacts,
  buildHappierCapabilityFacts,
  buildHappierCapabilityHeaderFacts,
  formatHappierCapabilityCount,
  type HappierCapabilityCost,
  type HappierCapabilityFact,
  type HappierCapabilityFactGlyph,
  type HappierCapabilityFactsInput,
  type HappierCapabilityFactsLabels,
  type HappierCapabilityFactsProps,
  type HappierCapabilityFactsTextProps,
  type HappierCapabilitySource,
  type HappierCapabilityTrust,
} from './capabilities/capabilityFacts.js';
export {
  buildHappierCapabilityCollectionAnatomy,
  type HappierCapabilityCollectionAnatomy,
  type HappierCapabilityCollectionAnatomyInput,
  type HappierCapabilityCollectionAnatomyParts,
} from './capabilities/capabilityCollectionAnatomy.js';
export {
  describeHappierOfflineMachines,
  describeHappierReach,
  describeHappierReachRule,
  foldHappierMachineNames,
  formatHappierWhereItsOnConsequence,
  formatHappierWhereItsOnSentence,
  happierWhereItsOnAgentNames,
  sayHappierWhereItsOn,
  shortHappierWhereItsOn,
  type HappierReachGrouped,
  type HappierReachPlace,
  type HappierReachRule,
  type HappierReachWrite,
  type HappierWhereItsOnClause,
  type HappierWhereItsOnClauseParams,
  type HappierWhereItsOnGroup,
  type HappierWhereItsOnConsequence,
  type HappierWhereItsOnItemKind,
  type HappierWhereItsOnLabels,
  type HappierWhereItsOnNames,
  type HappierWhereItsOnPlaceKind,
  type HappierWhereItsOnProjectionRow,
  type HappierWhereItsOnSentence,
  type HappierWhereItsOnStatement,
} from './capabilities/whereItsOn.js';
export {
  HappierWhereItsOnControl,
  collectHappierWhereItsOnAgentIds,
  happierWhereItsOnIntentWrites,
  type HappierWhereItsOnChangeResult,
  type HappierWhereItsOnControlLabels,
  type HappierWhereItsOnControlProps,
  type HappierWhereItsOnHost,
  type HappierWhereItsOnIntent,
  type HappierWhereItsOnMenuItem,
  type HappierWhereItsOnPlaces,
  type HappierWhereItsOnRuleState,
  type HappierWhereItsOnState,
  type HappierWhereItsOnTextProps,
} from './capabilities/WhereItsOnControl.js';
export {
  HAPPIER_CATALOG_LIST_ROLE,
  HappierCapabilityAddBody,
  HappierCapabilityAddFooter,
  useHappierCapabilityAddEdge,
  type HappierCapabilityAddBodyProps,
  type HappierCapabilityAddConfig,
  type HappierCapabilityAddDetailContext,
  type HappierCapabilityAddDetailFooter,
  type HappierCapabilityAddFound,
  type HappierCapabilityAddHost,
  type HappierCapabilityAddInputContext,
  type HappierCapabilityAddLabels,
  type HappierCapabilityAddLevel,
  type HappierCapabilityAddMode,
} from './capabilities/CapabilityAddBody.js';
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
} from './collection/CollectionRowContent.js';
