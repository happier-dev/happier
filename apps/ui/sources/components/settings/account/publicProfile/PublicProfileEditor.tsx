import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HappierPublicProfile } from '@happier-dev/plugin-ui/components';
import { HAPPIER_PAGE_METRICS, type HappierPublicProfileHeroGeometry, type HappierPublicProfileLabels, type HappierPublicProfileUsageHost } from '@happier-dev/plugin-ui/presentation';
import type { PublicProfileLocalPreviewViewV1 } from '@happier-dev/protocol/account/publicProfilePublication';

import { CorePluginUiPresentationScope } from '@/components/plugins/surfaces/CorePluginUiPresentationScope';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { PublishRiseLine } from './publicProfilePublishRise';

export type PublicProfileEditorView = Omit<
  PublicProfileLocalPreviewViewV1,
  'appearance'
>;
/** The page before its Usage can be read: who it belongs to, with no snapshot or blocks yet. */
export type PublicProfileEditorShell = Omit<PublicProfileEditorView, 'snapshot' | 'service'> &
  Readonly<{ snapshot: null }>;
export type PublicProfileEditorProps = Readonly<{
  status: 'draft' | 'published' | 'paused';
  mode: 'edit' | 'preview';
  onModeChange: (mode: 'edit' | 'preview') => void;
  /** How many members (consent, blocks, look) differ from the public edition. */
  changes: number;
  /** Every placed block with the owner's own local values; never uploaded. */
  ownerView: PublicProfileEditorView | null;
  /** Exactly what visitors would read, from the one disclosure projector. */
  visitorView: PublicProfileEditorView | null;
  /** The same page while no preview exists; its period line says why. */
  shellView?: PublicProfileEditorShell | null;
  hiddenBlockIds: ReadonlySet<string>;
  pageLabels: HappierPublicProfileLabels;
  usage?: HappierPublicProfileUsageHost;
  renderBand?: (geometry: HappierPublicProfileHeroGeometry) => React.ReactNode;
  singleColumn?: boolean;
  /** Why the page has no preview of its Usage yet, with the one way to try again. */
  unavailable?: Readonly<{ reason: string; onRetry: () => void }> | null;
  /** The outcome of the last Publish, Apply or consent request. */
  notice: string | null;
  /** The metadata owner's omission fact; no repository classification happens here. */
  omittedPrivateProjectCount?: number;
  /** A completed outcome reads as success; anything else needs the owner's attention. */
  noticeTone?: 'success' | 'warning';
  /** Undo for an acknowledged Apply: the notice then reports success and offers it. */
  noticeAction?: Readonly<{ label: string; onPress: () => void; testID?: string }> | null;
  /** After a first Publish the line is the result itself: the page's link, then Copy link and Badge. */
  noticeDetail?: string | null;
  noticeSecondaryAction?: Readonly<{ label: string; onPress: () => void; testID?: string }> | null;
  /** The first Publish's moment: the result line enters after the band's rise. */
  noticeMoment?: number | null;
  /** The result line finished entering for `noticeMoment`; a later remount shows it settled. */
  onNoticeEntered?: () => void;
  submitting: boolean;
  /** A pending or unavailable private-area copy cannot Apply an older local layout. */
  canSubmit?: boolean;
  /** The latest published consent change while its panel is closed. */
  consentStatus?: React.ReactNode;
  /** Edit arranges the owner's widget area in place of the projected blocks; Preview is the visitor page. */
  renderEditBlocks?: () => React.ReactNode;
  onSubmit: () => void;
  /** Look and Public data, each anchored to its own control. */
  renderTools: () => React.ReactNode;
}>;

/**
 * The owner's own page (lab `ppcomp-E`, `ppcomp-V`, `ppflow-F2`): the page header carries the state,
 * Edit | Preview and the one Publish or Apply; below it is the same placed tree visitors read. Edit
 * keeps the hero and identity and puts the customizing bar and the owner's widget area into the page;
 * Preview is exactly the visitor page. Nothing here is public until Publish or Apply.
 */
export function PublicProfileEditor(
  props: PublicProfileEditorProps,
): React.ReactElement {
  const view = (props.mode === 'edit' ? props.ownerView : props.visitorView) ?? props.shellView ?? null;
  const published = props.status !== 'draft';
  const statusLabel =
    props.status === 'draft'
      ? t('publicIdentity.editor.statusDraft')
      : props.status === 'paused'
        ? t('publicIdentity.editor.statusPaused')
        : t('publicIdentity.editor.statusPublished');
  const hint = !published
    ? t('publicIdentity.editor.hintNew')
    : props.changes > 0
      ? t('publicIdentity.editor.hintChanges', { count: props.changes })
      : t('publicIdentity.editor.hintNone');
  const unavailable = props.unavailable ? (
    <SurfaceStateCard
      testID="public-profile-editor-unavailable"
      kind="unavailable"
      layout="inline"
      size="line"
      title={props.unavailable.reason}
      action={{ testID: 'public-profile-editor-retry', label: t('publicIdentity.profile.retry'), onPress: props.unavailable.onRetry }}
    />
  ) : null;
  const notice = props.notice ? (
    <PublishRiseLine moment={props.noticeMoment ?? null} onEntered={props.onNoticeEntered}>
    <SurfaceStateCard
      testID="public-profile-editor-notice"
      kind={props.noticeAction || props.noticeTone === 'success' ? 'success' : 'warning'}
      layout="inline"
      size="line"
      title={props.notice}
      {...(props.noticeDetail ? { reason: props.noticeDetail } : {})}
      {...(props.noticeAction ? { action: { testID: 'public-profile-editor-undo', ...props.noticeAction } } : {})}
      {...(props.noticeSecondaryAction ? { secondaryAction: props.noticeSecondaryAction } : {})}
    />
    </PublishRiseLine>
  ) : null;
  const omissions = props.omittedPrivateProjectCount ? (
    <SurfaceStateCard testID="public-profile-private-project-omissions" kind="warning" layout="inline" size="line"
      title={t('publicIdentity.editor.privateProjectsOmitted', { count: props.omittedPrivateProjectCount })} />
  ) : null;
  const toolbar = (
    <View style={styles.toolbar}>
      <View style={[styles.banner, props.singleColumn ? styles.bannerStacked : null]} testID="public-profile-editor-banner">
        <View style={styles.bannerText}>
          <Text variant="label" emphasis="semiBold" style={styles.primary}>
            {t('publicIdentity.editor.customizing')}
          </Text>
          <Text variant="meta" style={styles.secondary}>
            {hint}
          </Text>
        </View>
        <View style={styles.tools}>{props.renderTools()}</View>
      </View>
      {unavailable}
      {notice}
      {omissions}
      {props.consentStatus}
    </View>
  );
  return (
    <View style={styles.page} testID="public-profile-editor">
      <SettingsPageHeader
        meta={[{ key: 'status', text: statusLabel, testID: 'public-profile-editor-status' }]}
        actionsPlacement="page"
        actions={
          <SegmentedTabBar<'edit' | 'preview'>
            tabs={[
              { id: 'edit', label: t('publicIdentity.editor.edit') },
              { id: 'preview', label: t('publicIdentity.editor.preview') },
            ]}
            activeTabId={props.mode}
            onSelectTab={props.onModeChange}
            testIDPrefix="public-profile-editor-mode"
            segmentSizing="content"
          />
        }
        primaryAction={{
          testID: 'public-profile-editor-submit',
          title: published ? t('publicIdentity.editor.apply') : t('publicIdentity.editor.publish'),
          disabled: props.submitting || props.canSubmit === false || (published && props.changes === 0),
          loading: props.submitting,
          onPress: props.onSubmit,
        }}
      />
      {props.mode === 'preview' && (unavailable || notice || omissions || props.consentStatus) ? (
        <View style={styles.previewNotices}>
          {unavailable}
          {notice}
          {omissions}
          {props.consentStatus}
        </View>
      ) : null}
      {view ? (
        <CorePluginUiPresentationScope>
          <HappierPublicProfile
            view={view}
            labels={props.pageLabels}
            usage={props.usage}
            singleColumn={props.singleColumn}
            renderHero={props.renderBand}
            {...(props.mode === 'edit'
              ? {
                  owner: {
                    hiddenBlockIds: props.hiddenBlockIds,
                    onlyYou: t('publicIdentity.editor.onlyYou'),
                    renderToolbar: () => toolbar,
                    ...(props.renderEditBlocks
                      ? { renderBlocks: props.renderEditBlocks }
                      : {}),
                  },
                }
              : {})}
          />
        </CorePluginUiPresentationScope>
      ) : (
        <SurfaceStateCard
          testID="public-profile-editor-preparing"
          kind="loading"
          title={t('publicIdentity.editor.preparing')}
          replacesContent
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  page: { width: '100%' },
  toolbar: { gap: theme.space.s8 },
  previewNotices: {
    width: '100%',
    maxWidth: HAPPIER_PAGE_METRICS.columnMaxWidthPx.wide,
    alignSelf: 'center',
    paddingHorizontal: HAPPIER_PAGE_METRICS.sheetInsetPx,
    gap: theme.space.s8,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: theme.space.s12,
    paddingHorizontal: theme.space.s16,
    paddingVertical: theme.space.s10,
    borderRadius: theme.borderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border.default,
  },
  // A phone keeps the bar's words whole and puts its controls beneath them.
  bannerStacked: { flexDirection: 'column', alignItems: 'stretch' },
  bannerText: { flexGrow: 1, flexShrink: 1, minWidth: 0, gap: theme.space.s2 },
  primary: { color: theme.colors.text.primary },
  secondary: { color: theme.colors.text.secondary },
  tools: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: theme.space.s8 },
}));
