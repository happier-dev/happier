import * as React from 'react';
import { View } from 'react-native';
import { Image } from 'expo-image';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import {
  PublicEmbedResultV1Schema,
  type PublicEmbedInputV1,
  type PublicEmbedResultV1,
} from '@happier-dev/protocol/account/publicProfileEmbeds';
import {
  PublicProfileOwnerReadV1Schema,
  type PublicProfileOwnerReadV1,
} from '@happier-dev/protocol/account/publicProfilePublication';
import { HappierSkeletonBlock } from '@happier-dev/plugin-ui/presentation';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import type { PluginUiJsonValueV1 } from '@happier-dev/protocol/plugins/ui';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import {
  fieldBoxShapeStyle,
  resolveFieldBoxColors,
} from '@/components/ui/forms/fieldBox';
import { Icon } from '@/components/ui/icons/Icon';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';
import { darkTheme, lightTheme } from '@/theme';
import { RecapComposerFrame } from './RecapComposerFrame';

export type UsageRecapPublicOutputKind = 'profile_link' | 'badge' | 'card';
type Metric = Extract<PublicEmbedInputV1, { kind: 'badge' }>['metric'];
type EmbedTheme = PublicEmbedInputV1['theme'];
type Syntax = PublicEmbedInputV1['syntax'];

const METRICS: readonly Metric[] = [
  'tokens',
  'agent-time',
  'merged-prs',
  'streak',
  'peak-parallel',
];
const THEMES: readonly EmbedTheme[] = ['auto', 'light', 'dark'];
const SYNTAXES: readonly Syntax[] = ['markdown', 'html', 'picture', 'url'];
/** The Home's own image sizes: the K1 card and the G1 link-preview picture. */
const CARD_ASPECT = 495 / 195;
const OG_ASPECT = 1200 / 630;
const BADGE_HEIGHT_PX = 20;

type Execution = ReturnType<typeof useMountedActionExecution>;
type Unavailable = Extract<
  PublicEmbedResultV1,
  { kind: 'unavailable' }
>['reason'];
type Ready = Extract<PublicEmbedResultV1, { kind: 'ready' }>;

/**
 * The Profile link, Badge and Card outputs of the Share sheet (lab C1). Everything they show comes
 * from the Account's published page: the link from `account.public_profile.get`, badge and card text
 * and images from `account.public_profile.embed.get`. Copy goes through `clipboard.write` and says
 * what really happened. Without a published page each tab explains that and leads to its preview;
 * nothing here publishes.
 */
export function UsageRecapPublicOutput(
  props: Readonly<{
    kind: UsageRecapPublicOutputKind;
    serverId: string;
    onClose: () => void;
    callerContext: React.MutableRefObject<ActionExecutorContext | undefined>;
  }>,
): React.ReactElement {
  const execution = useMountedActionExecution(props.serverId);
  const router = useRouter();
  const { onClose } = props;
  const openProfile = React.useCallback(() => {
    onClose();
    router.push(SETTINGS_ROUTES.accountPublicProfile);
  }, [onClose, router]);
  const commands = useCurrentUiContextLocalCommands([{ key: 'profile', title: t('publicIdentity.share.previewProfile'),
    invoke: openProfile }], { foregroundOverlay: true });
  const previewProfile = () => { void commands.invoke('profile'); };
  return props.kind === 'profile_link' ? (
    <ProfileLinkOutput execution={execution} openProfile={previewProfile} callerContext={props.callerContext} />
  ) : (
    <EmbedOutput
      kind={props.kind}
      execution={execution}
      openProfile={previewProfile}
      callerContext={props.callerContext}
    />
  );
}

type CopyNotice = 'copied' | 'failed' | null;

/** A copy is only "Copied" when the platform clipboard took it; a refusal leaves the text to select. */
function useCopyText(execution: Execution, text: string | null) {
  const [notice, setNotice] = React.useState<CopyNotice>(null);
  const [copying, setCopying] = React.useState(false);
  React.useEffect(() => setNotice(null), [text]);
  const { execute, isCurrent } = execution;
  const copy = React.useCallback(async (context?: ActionExecutorContext) => {
    if (text === null) return;
    setCopying(true);
    setNotice(null);
    let next: CopyNotice = 'failed';
    try {
      const result = await execute('clipboard.write', { text }, { callerContext: context });
      next = result.ok
        ? 'copied'
        : isActionApprovalDeclinedErrorCode(result.errorCode)
          ? null
          : 'failed';
    } catch {
      // A lost or refused delivery is a failure; it never becomes a copied check.
    }
    if (!isCurrent()) return;
    setNotice(next);
    setCopying(false);
  }, [execute, isCurrent, text]);
  const commands = useCurrentUiContextLocalCommands(text !== null && !copying
    ? [{ key: 'copy', title: t('common.copy'),
      invoke: (_input?: PluginUiJsonValueV1, context?: ActionExecutorContext) => copy(context) }] : [], { foregroundOverlay: true });
  return { notice, copying, copy: () => commands.invoke('copy') };
}

function noticeText(notice: CopyNotice, fallback: string): string {
  return notice === 'copied'
    ? t('publicIdentity.share.copied')
    : notice === 'failed'
      ? t('publicIdentity.share.copyFailed')
      : fallback;
}

function CopyButton(
  props: Readonly<{
    title: string;
    disabled: boolean;
    loading: boolean;
    onPress: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  return (
    <>
      <View style={styles.grow} />
      <RoundButton
        size="small"
        title={props.title}
        leading={
          <Icon
            name="copy"
            size={14}
            color={theme.colors.button.primary.tint}
          />
        }
        disabled={props.disabled}
        loading={props.loading}
        onPress={props.onPress}
        testID="usage-recap-share.copy"
      />
    </>
  );
}

/** The prerequisite every public output shares: a published page, reached through its preview. */
function Unpublished(
  props: Readonly<{
    kind: UsageRecapPublicOutputKind;
    openProfile: () => void;
  }>,
) {
  return (
    <RecapComposerFrame
      stage={
        <View style={styles.stageCentered}>
          <SurfaceStateCard
            kind="empty"
            iconName="globe"
            title={t(`publicIdentity.share.unpublished_${props.kind}`)}
            reason={t('publicIdentity.share.unpublishedBody')}
            action={{
              label: t('publicIdentity.share.previewProfile'),
              onPress: props.openProfile,
            }}
          />
        </View>
      }
      controls={null}
      note={t('publicIdentity.share.imagesWithoutProfile')}
      noteTestID="usage-recap-share.note"
      actions={null}
    />
  );
}

function ReadFailed(props: Readonly<{ code: string; onRetry: () => void }>) {
  return (
    <View style={styles.stageCentered}>
      <SurfaceStateCard
        kind="error"
        title={t('publicIdentity.share.readFailed')}
        reason={t('publicIdentity.share.readFailedBody')}
        diagnosticCode={props.code}
        action={{ label: t('common.retry'), onPress: props.onRetry }}
      />
    </View>
  );
}

type LinkState =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'ready'; read: PublicProfileOwnerReadV1 }>
  | Readonly<{ kind: 'failed'; code: string }>;

function ProfileLinkOutput(
  props: Readonly<{ execution: Execution; openProfile: () => void; callerContext: React.MutableRefObject<ActionExecutorContext | undefined> }>,
) {
  const { theme } = useUnistyles();
  const { execute, ready } = props.execution;
  const [state, setState] = React.useState<LinkState>({ kind: 'loading' });
  const [attempt, retry] = React.useReducer((value: number) => value + 1, 0);
  const commands = useCurrentUiContextLocalCommands(state.kind === 'failed'
    ? [{ key: 'retry', title: t('common.retry'),
      invoke: (_input?: PluginUiJsonValueV1, context?: ActionExecutorContext) => { props.callerContext.current = context; retry(); } }] : [], { foregroundOverlay: true });
  React.useEffect(() => {
    if (!ready) return;
    let live = true;
    const origin = props.callerContext.current;
    void (async () => {
      const result = await execute('account.public_profile.get', {}, { callerContext: origin ? { ...origin, signal: undefined } : undefined });
      if (!live) return;
      if (!result.ok)
        return setState({ kind: 'failed', code: result.errorCode });
      const parsed = PublicProfileOwnerReadV1Schema.safeParse(result.result);
      setState(
        parsed.success
          ? { kind: 'ready', read: parsed.data }
          : { kind: 'failed', code: 'public_profile_result_invalid' },
      );
    })().catch(() => {
      if (live)
        setState({ kind: 'failed', code: 'public_profile_read_failed' });
    });
    return () => {
      live = false;
    };
  }, [execute, ready, attempt]);

  const read = state.kind === 'ready' ? state.read : null;
  const record = read?.kind === 'ready' ? read.record : null;
  const published =
    record?.state === 'published' && record.restriction === null;
  const urls = published ? (read?.context.urls ?? null) : null;
  const { notice, copying, copy } = useCopyText(
    props.execution,
    urls?.page ?? null,
  );
  if (state.kind === 'ready' && !urls)
    return <Unpublished kind="profile_link" openProfile={props.openProfile} />;

  const fieldColors = resolveFieldBoxColors(theme, 'idle', 'document');
  const name = read?.context.identity.name;
  const handle = read?.context.handle ?? '';
  const service = read?.context.service?.displayName ?? '';
  return (
    <RecapComposerFrame
      stage={
        state.kind === 'failed' ? (
          <ReadFailed code={state.code} onRetry={() => { void commands.invoke('retry'); }} />
        ) : urls ? (
          // The unfurl as people will see it where the link is posted: the page's own preview picture.
          <View
            style={[
              styles.unfurl,
              {
                borderColor: theme.colors.border.default,
                backgroundColor: theme.colors.surface.base,
              },
            ]}
          >
            <View style={styles.unfurlText}>
              <Text variant="meta" emphasis="semiBold" numberOfLines={1}>
                {service}
              </Text>
              <Text
                variant="body"
                style={{ color: theme.colors.text.link }}
                numberOfLines={1}
              >
                {name
                  ? t('publicIdentity.share.unfurlTitleNamed', {
                      name,
                      handle,
                      service,
                    })
                  : t('publicIdentity.share.unfurlTitle', { handle, service })}
              </Text>
            </View>
            <Image
              source={{ uri: urls.og }}
              style={[
                styles.fullWidth,
                {
                  aspectRatio: OG_ASPECT,
                  backgroundColor: theme.colors.surface.inset,
                },
              ]}
              contentFit="cover"
              accessibilityLabel={t('publicIdentity.share.previewImage')}
              testID="usage-recap-share.preview-og"
            />
          </View>
        ) : (
          <StagePlaceholder aspect={OG_ASPECT} />
        )
      }
      controls={
        <>
          <ItemGroup title={t('publicIdentity.profile.link')} surface="none">
            <View
              style={[
                fieldBoxShapeStyle,
                styles.valueBox,
                { backgroundColor: fieldColors.backgroundColor },
              ]}
            >
              <Text
                variant="body"
                selectable
                style={[styles.mono, { color: fieldColors.valueColor }]}
                testID="usage-recap-share.link"
              >
                {urls?.page ?? ''}
              </Text>
            </View>
          </ItemGroup>
          <ItemGroup
            title={t('publicIdentity.share.previewImage')}
            surface="none"
          >
            <Text variant="body" style={{ color: theme.colors.text.secondary }}>
              {t('publicIdentity.share.previewImageDetail')}
            </Text>
          </ItemGroup>
          {record?.policy ? (
            <ItemGroup
              title={t('publicIdentity.profile.searchEngines')}
              surface="none"
            >
              <Text
                variant="body"
                style={{ color: theme.colors.text.secondary }}
              >
                {t(
                  record.policy.indexable
                    ? 'publicIdentity.profile.indexOn'
                    : 'publicIdentity.profile.indexOff',
                )}
              </Text>
            </ItemGroup>
          ) : null}
        </>
      }
      note={noticeText(notice, '')}
      noteTestID="usage-recap-share.note"
      actions={
        <CopyButton
          title={t('publicIdentity.share.copyLink')}
          disabled={!urls || copying}
          loading={copying}
          onPress={() => {
            void copy();
          }}
        />
      }
    />
  );
}

type EmbedState =
  | Readonly<{
      kind: 'loading';
      shown?: Readonly<{ snippet: Ready; light: string; dark: string }>;
    }>
  | Readonly<{ kind: 'ready'; snippet: Ready; light: string; dark: string }>
  | Readonly<{ kind: 'unavailable'; reason: Unavailable }>
  | Readonly<{ kind: 'failed'; code: string }>;

class EmbedReadError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function EmbedOutput(
  props: Readonly<{
    kind: 'badge' | 'card';
    execution: Execution;
    openProfile: () => void;
    callerContext: React.MutableRefObject<ActionExecutorContext | undefined>;
  }>,
) {
  const { theme } = useUnistyles();
  const { execute, ready } = props.execution;
  const [metric, setMetric] = React.useState<Metric>('tokens');
  const [embedTheme, setEmbedTheme] = React.useState<EmbedTheme>('auto');
  const [syntax, setSyntax] = React.useState<Syntax>('markdown');
  const [metricMenuOpen, setMetricMenuOpen] = React.useState(false);
  const [state, setState] = React.useState<EmbedState>({ kind: 'loading' });
  const [attempt, retry] = React.useReducer((value: number) => value + 1, 0);
  const { kind } = props;
  const metricLabel = (id: Metric) => t(`publicIdentity.share.metric_${METRIC_KEYS[id]}`);
  const commands = useCurrentUiContextLocalCommands([
    ...(kind === 'badge' ? METRICS.map(id => ({ key: `metric:${id}`,
      title: `${t('publicIdentity.share.shows')}: ${metricLabel(id)}`,
      invoke: (_input?: PluginUiJsonValueV1, context?: ActionExecutorContext) => { props.callerContext.current = context; setMetric(id); setMetricMenuOpen(false); } })) : []),
    ...THEMES.map(id => ({ key: `theme:${id}`,
      title: `${t('publicIdentity.share.theme')}: ${t(`publicIdentity.share.theme_${id}`)}`,
      invoke: (_input?: PluginUiJsonValueV1, context?: ActionExecutorContext) => { props.callerContext.current = context; setEmbedTheme(id); } })),
    ...SYNTAXES.map(id => ({ key: `syntax:${id}`,
      title: `${t('publicIdentity.share.copyAs')}: ${t(`publicIdentity.share.syntax_${id}`)}`,
      invoke: (_input?: PluginUiJsonValueV1, context?: ActionExecutorContext) => { props.callerContext.current = context; setSyntax(id); } })),
    ...(kind === 'badge' ? [{ key: 'metric-menu', title: t('publicIdentity.share.shows'),
      invoke: (input?: PluginUiJsonValueV1) => setMetricMenuOpen(typeof input === 'boolean' ? input : !metricMenuOpen) }] : []),
    ...(state.kind === 'failed' || state.kind === 'unavailable' ? [{ key: 'retry', title: t('common.retry'),
      invoke: (_input?: PluginUiJsonValueV1, context?: ActionExecutorContext) => { props.callerContext.current = context; retry(); } }] : []),
  ], { foregroundOverlay: true, contextKey: kind });

  React.useEffect(() => {
    if (!ready) return;
    let live = true;
    const origin = props.callerContext.current;
    // A new choice keeps the shown previews and snippet until the Home formats the new one.
    setState((previous) => ({
      kind: 'loading',
      shown:
        previous.kind === 'ready'
          ? previous
          : previous.kind === 'loading'
            ? previous.shown
            : undefined,
    }));
    const read = async (
      input: Readonly<{ theme: EmbedTheme; syntax: Syntax }>,
    ): Promise<PublicEmbedResultV1> => {
      const result = await execute(
        'account.public_profile.embed.get',
        kind === 'badge' ? { kind, metric, ...input } : { kind, ...input },
        { callerContext: origin ? { ...origin, signal: undefined } : undefined },
      );
      if (!result.ok) throw new EmbedReadError(result.errorCode);
      const parsed = PublicEmbedResultV1Schema.safeParse(result.result);
      if (!parsed.success)
        throw new EmbedReadError('public_profile_embed_result_invalid');
      return parsed.data;
    };
    void (async () => {
      const [snippet, light, dark] = await Promise.all([
        read({ theme: embedTheme, syntax }),
        read({ theme: 'light', syntax: 'url' }),
        read({ theme: 'dark', syntax: 'url' }),
      ]);
      if (!live) return;
      const unavailable = [snippet, light, dark].find(
        (result) => result.kind === 'unavailable',
      );
      if (unavailable?.kind === 'unavailable')
        return setState({ kind: 'unavailable', reason: unavailable.reason });
      if (
        snippet.kind !== 'ready' ||
        light.kind !== 'ready' ||
        dark.kind !== 'ready'
      )
        return;
      setState({ kind: 'ready', snippet, light: light.url, dark: dark.url });
    })().catch((error: unknown) => {
      if (live)
        setState({
          kind: 'failed',
          code:
            error instanceof EmbedReadError
              ? error.code
              : 'public_profile_embed_failed',
        });
    });
    return () => {
      live = false;
    };
  }, [execute, ready, kind, metric, embedTheme, syntax, attempt]);

  const shown =
    state.kind === 'ready'
      ? state
      : state.kind === 'loading'
        ? (state.shown ?? null)
        : null;
  const copyable = state.kind === 'ready' ? state.snippet.snippet : null;
  const { notice, copying, copy } = useCopyText(props.execution, copyable);
  if (state.kind === 'unavailable' && state.reason === 'not_published') {
    return <Unpublished kind={kind} openProfile={props.openProfile} />;
  }

  const stage =
    state.kind === 'failed' ? (
      <ReadFailed code={state.code} onRetry={() => { void commands.invoke('retry'); }} />
    ) : state.kind === 'unavailable' ? (
      <View style={styles.stageCentered}>
        {state.reason === 'field_hidden' ? (
          <SurfaceStateCard
            kind="empty"
            iconName="eye-slash"
            title={t('publicIdentity.share.metricHidden', {
              metric: metricLabel(metric),
            })}
            reason={t('publicIdentity.share.metricHiddenBody')}
            action={{
              label: t('publicIdentity.share.previewProfile'),
              onPress: props.openProfile,
            }}
          />
        ) : (
          <SurfaceStateCard
            kind="unavailable"
            title={t('publicIdentity.share.serviceUnavailable')}
            reason={t('publicIdentity.share.readFailedBody')}
            diagnosticCode={state.reason}
            action={{ label: t('common.retry'), onPress: () => { void commands.invoke('retry'); } }}
          />
        )}
      </View>
    ) : (
      <View
        style={[
          styles.previews,
          shown && state.kind === 'loading' ? styles.stale : null,
        ]}
      >
        {(['light', 'dark'] as const).map((tone) =>
          kind === 'badge' ? (
            <ReadmePreview
              key={tone}
              tone={tone}
              uri={shown?.[tone] ?? null}
              label={shown?.snippet.accessibleLabel ?? ''}
            />
          ) : (
            <CardPreview
              key={tone}
              tone={tone}
              uri={shown?.[tone] ?? null}
              label={shown?.snippet.accessibleLabel ?? ''}
            />
          ),
        )}
      </View>
    );

  const fieldColors = resolveFieldBoxColors(theme, 'idle', 'document');
  const controls = (
    <>
      {kind === 'badge' ? (
        <ItemGroup>
          <DropdownMenu
            testID="usage-recap-share.metric"
            open={metricMenuOpen}
            onOpenChange={open => { void commands.invoke('metric-menu', open); }}
            variant="selectable"
            search={false}
            selectedId={metric}
            showCategoryTitles={false}
            matchTriggerWidth
            connectToTrigger
            rowKind="item"
            itemTrigger={{ title: t('publicIdentity.share.shows') }}
            items={METRICS.map((id) => ({ id, title: metricLabel(id) }))}
            onSelect={(id) => {
              void commands.invoke(`metric:${id}`);
            }}
          />
        </ItemGroup>
      ) : null}
      <ItemGroup title={t('publicIdentity.share.theme')} surface="none">
        <SegmentedTabBar
          testIDPrefix="usage-recap-share-theme"
          role="radiogroup"
          compact
          segmentSizing="content"
          activeTabId={embedTheme}
          onSelectTab={id => { void commands.invoke(`theme:${id}`); }}
          accessibilityLabel={t('publicIdentity.share.theme')}
          tabs={THEMES.map((id) => ({
            id,
            label: t(`publicIdentity.share.theme_${id}`),
          }))}
        />
      </ItemGroup>
      <ItemGroup title={t('publicIdentity.share.copyAs')} surface="none">
        <View style={styles.snippetGroup}>
          <SegmentedTabBar
            testIDPrefix="usage-recap-share-syntax"
            role="radiogroup"
            compact
            segmentSizing="content"
            activeTabId={syntax}
            onSelectTab={id => { void commands.invoke(`syntax:${id}`); }}
            accessibilityLabel={t('publicIdentity.share.copyAs')}
            tabs={SYNTAXES.map((id) => ({
              id,
              label: t(`publicIdentity.share.syntax_${id}`),
            }))}
          />
          <View
            style={[
              fieldBoxShapeStyle,
              styles.valueBox,
              { backgroundColor: fieldColors.backgroundColor },
            ]}
          >
            <Text
              variant="meta"
              selectable
              style={[
                styles.mono,
                {
                  color: shown
                    ? fieldColors.valueColor
                    : fieldColors.placeholderColor,
                },
              ]}
              testID="usage-recap-share.snippet"
            >
              {shown?.snippet.snippet ?? ''}
            </Text>
          </View>
        </View>
      </ItemGroup>
    </>
  );
  return (
    <RecapComposerFrame
      stage={stage}
      controls={controls}
      note={noticeText(notice, t(`publicIdentity.share.liveNote_${kind}`))}
      noteTestID="usage-recap-share.note"
      actions={
        <CopyButton
          title={t('publicIdentity.share.copySnippet')}
          disabled={copyable === null || copying}
          loading={copying}
          onPress={() => {
            void copy();
          }}
        />
      }
    />
  );
}

const METRIC_KEYS = {
  tokens: 'tokens',
  'agent-time': 'agentTime',
  'merged-prs': 'mergedPrs',
  streak: 'streak',
  'peak-parallel': 'peakParallel',
} as const satisfies Record<Metric, string>;

/** The place an image will take while the Home formats it: its own size, so nothing moves on arrival. */
function StagePlaceholder(
  props: Readonly<{ aspect: number; tone?: 'light' | 'dark' }>,
) {
  const { theme } = useUnistyles();
  const reducedMotion = useReducedMotionPreference();
  const [width, setWidth] = React.useState<number | null>(null);
  return (
    <View
      style={styles.fullWidth}
      onLayout={(event) => setWidth(Math.round(event.nativeEvent.layout.width))}
    >
      {width ? (
        <HappierSkeletonBlock
          color={
            (props.tone ? TONES[props.tone] : theme).colors.surface.skeleton
          }
          width={width}
          height={width / props.aspect}
          radius={theme.borderRadius.md}
          reducedMotion={reducedMotion}
        />
      ) : null}
    </View>
  );
}

const TONES = { light: lightTheme, dark: darkTheme } as const;

/**
 * A README as it reads on a light or a dark code host, with the Home's own badge image in it. The
 * page colours are the app's own light and dark themes, so both previews show whatever theme is on.
 */
function ReadmePreview(
  props: Readonly<{
    tone: 'light' | 'dark';
    uri: string | null;
    label: string;
  }>,
) {
  const colors = TONES[props.tone].colors;
  return (
    <View
      style={[
        styles.readme,
        {
          backgroundColor: colors.surface.base,
          borderColor: colors.border.default,
        },
      ]}
    >
      <Text variant="meta" style={{ color: colors.text.secondary }}>
        README.md
      </Text>
      <View
        style={[styles.readmeHeading, { backgroundColor: colors.text.primary }]}
      />
      <View style={styles.badgeRow}>
        {props.uri ? (
          <Image
            source={{ uri: props.uri }}
            style={styles.badge}
            contentFit="contain"
            contentPosition="left"
            accessibilityLabel={props.label}
            testID={`usage-recap-share.preview-${props.tone}`}
          />
        ) : null}
      </View>
      <View
        style={[styles.readmeLine, { backgroundColor: colors.border.default }]}
      />
      <View
        style={[
          styles.readmeLine,
          styles.readmeLineShort,
          { backgroundColor: colors.border.default },
        ]}
      />
    </View>
  );
}

/** The Home's K1 card image on a light and a dark page: the same file people embed. */
function CardPreview(
  props: Readonly<{
    tone: 'light' | 'dark';
    uri: string | null;
    label: string;
  }>,
) {
  const colors = TONES[props.tone].colors;
  return (
    <View
      style={[
        styles.cardPage,
        {
          backgroundColor: colors.surface.base,
          borderColor: colors.border.default,
        },
      ]}
    >
      {props.uri ? (
        <Image
          source={{ uri: props.uri }}
          style={[styles.fullWidth, { aspectRatio: CARD_ASPECT }]}
          contentFit="contain"
          accessibilityLabel={props.label}
          testID={`usage-recap-share.preview-${props.tone}`}
        />
      ) : (
        <StagePlaceholder aspect={CARD_ASPECT} tone={props.tone} />
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  grow: { flexGrow: 1 },
  fullWidth: { width: '100%' },
  stageCentered: { flex: 1, alignSelf: 'stretch', justifyContent: 'center' },
  previews: {
    alignSelf: 'stretch',
    gap: theme.space.s16,
    maxWidth: 560,
    width: '100%',
    marginHorizontal: 'auto',
  },
  stale: { opacity: 0.55 },
  readme: {
    gap: theme.space.s8,
    padding: theme.space.s16,
    borderRadius: theme.borderRadius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  readmeHeading: { height: 12, width: '32%', borderRadius: 3, opacity: 0.85 },
  badgeRow: { height: BADGE_HEIGHT_PX },
  badge: { height: BADGE_HEIGHT_PX, width: '100%' },
  readmeLine: { height: 6, width: '88%', borderRadius: 3 },
  readmeLineShort: { width: '58%' },
  cardPage: {
    padding: theme.space.s16,
    borderRadius: theme.borderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  unfurl: {
    alignSelf: 'center',
    width: '100%',
    maxWidth: 440,
    overflow: 'hidden',
    borderRadius: theme.borderRadius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  unfurlText: {
    gap: theme.space.s2,
    paddingHorizontal: theme.space.s16,
    paddingVertical: theme.space.s12,
  },
  snippetGroup: { gap: theme.space.s12 },
  valueBox: {
    paddingHorizontal: theme.space.s12,
    paddingVertical: theme.space.s10,
  },
  mono: { ...Typography.mono() },
}));
