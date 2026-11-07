import * as React from 'react';
import {
  Avatar,
  Badge,
  Button,
  Icon,
  IconButton,
  Markdown,
  Menu,
  Row,
  Spinner,
  Stack,
  Text,
  usePluginTheme,
  usePluginTranslation,
} from '@happier-dev/plugin-ui';
import { formatHappierDataBytes } from '@happier-dev/plugin-ui/components';
import type {
  ForgeReleaseAssetV1,
  ForgeReleaseV1,
} from '@happier-dev/triage-protocol/releases/v1';
import type { ReleaseAssetDownloadV1 } from './downloads.js';
import type { ForgeReleaseActionInputByOperationV1 } from '@happier-dev/triage-protocol/releases/v1';
import type { TriageSessionHandoffSelectionV1 } from '@happier-dev/triage-protocol/v1';
import { projectGithubReleaseIdentityV1 } from '../../releases/mapping.js';

/**
 * The release story, shared by the Newest hero, an expanded Earlier row and the phone detail page:
 * identity (tag and name), the provider's own marks, who published it and when, the notes at reading
 * width and the assets. Healthy is quiet: every mark is ink; nothing here is coloured.
 */


/**
 * A plain button on its own line puts its label on the column edge; its hover and press fill reach into
 * the gutter by the padding it gave up. Nothing here measures the box, so a real margin (siblings follow) is safe.
 */
export function ReleaseEdgeAligned(props: Readonly<{ children: React.ReactNode }>): React.ReactElement {
  const theme = usePluginTheme();
  return (
    <Stack gap="none" style={{ marginLeft: -(theme.spacing.medium + 1), flexShrink: 1 }}>
      {props.children}
    </Stack>
  );
}

/** What a person asks a session for. The consumer (Triage's configured handoff) owns Session, Agent and delivery. */
export type ReleaseSessionHelpIntentV1 =
  | Readonly<{ kind: 'draft' }>
  | Readonly<{ kind: 'notes'; releaseId: string | null }>;
/**
 * `choice` is the person's pick from the offered configured actions, or `'choose'` to see them all; omitted, the
 * configured default runs. With no default, the result is `{ kind: 'choose', actions }` and nothing is sent.
 */
export type ReleaseSessionHelpV1 = (intent: ReleaseSessionHelpIntentV1, evidence?: Readonly<{
  selector: ForgeReleaseActionInputByOperationV1['readNotesContext']['selector'];
  proposedNotes?: string;
}>, choice?: TriageSessionHandoffSelectionV1 | 'choose') => Promise<unknown>;
export type ReleaseSessionChoiceV1 = Readonly<{ label: string; selection: TriageSessionHandoffSelectionV1 }>;

/** The offered configured actions when the person has to pick one, else null. */
export function readReleaseSessionChoicesV1(result: unknown): readonly ReleaseSessionChoiceV1[] | null {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return null;
  const value = result as Readonly<{ kind?: unknown; actions?: unknown }>;
  return value.kind === 'choose' && Array.isArray(value.actions) ? value.actions as readonly ReleaseSessionChoiceV1[] : null;
}

/**
 * The one "in a session" entry: a secondary button that runs the configured default, and beside it the offered
 * configured actions to choose from. With no default the button opens that same choice instead of taking a row on
 * the person's behalf. Rendered only where a handoff is mounted, so no page shows a control that cannot act.
 */
export function ReleaseSessionHelpButton(
  props: Readonly<{
    help: ReleaseSessionHelpV1 | undefined;
    intent: ReleaseSessionHelpIntentV1;
    disabled?: boolean;
    variant?: 'secondary' | 'plain';
  }>,
): React.ReactElement | null {
  const t = usePluginTranslation();
  const [busy, setBusy] = React.useState(false);
  const [choices, setChoices] = React.useState<readonly ReleaseSessionChoiceV1[] | null>(null);
  const mounted = React.useRef(true);
  React.useEffect(() => () => { mounted.current = false; }, []);
  if (!props.help) return null;
  const help = props.help;
  const run = (choice?: TriageSessionHandoffSelectionV1 | 'choose') => {
    setBusy(true);
    void help(props.intent, undefined, choice)
      .then((result) => { if (mounted.current) setChoices(readReleaseSessionChoicesV1(result)); })
      .catch(() => undefined)
      .finally(() => { if (mounted.current) setBusy(false); });
  };
  const title = props.intent.kind === 'draft'
    ? t('plugins.github.releases.session.draft', 'Draft in a session')
    : t('plugins.github.releases.session.notes', 'Notes help in a session');
  return (
    <Row gap="xsmall" align="center">
      <Stack grow gap="none" align="stretch">
        <Button
          variant={props.variant ?? 'secondary'}
          icon={<Icon name="send" size="small" />}
          busy={busy}
          disabled={props.disabled}
          title={title}
          onPress={() => run()}
        />
      </Stack>
      <Menu
        open={choices !== null}
        onOpenChange={(open) => { if (open) run('choose'); else setChoices(null); }}
        trigger={t('plugins.github.releases.session.choose', 'Choose how a session helps')}
        triggerIcon="more"
        triggerAccessibilityLabel={t('plugins.github.releases.session.choose', 'Choose how a session helps')}
        disabled={props.disabled === true || busy}
        items={(choices ?? []).map((choice, index) => ({ id: String(index), label: choice.label }))}
        onSelect={(id) => {
          const choice = choices?.[Number(id)];
          setChoices(null);
          if (choice) run(choice.selection);
        }}
      />
    </Row>
  );
}

const NOTES_CLIP_PX = 236;

export function formatReleaseDayV1(
  iso: string | null | undefined,
  locale: string,
  now = Date.now(),
): string | null {
  if (!iso) return null;
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return null;
  const days = Math.floor((now - time) / 86_400_000);
  if (days < 1)
    return new Intl.DateTimeFormat(locale, {
      hour: 'numeric',
      minute: '2-digit',
    }).format(time);
  if (days < 7)
    return new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(time);
  const sameYear = new Date(time).getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(
    locale,
    sameYear
      ? { month: 'short', day: 'numeric' }
      : { year: 'numeric', month: 'short', day: 'numeric' },
  ).format(time);
}

/** A commit target reads as its short id, the way the commit is named everywhere else; a branch keeps its name. */
/**
 * GitHub's own answer about a refused request (the classifier keeps its permission header in the failure detail,
 * `contents=write; metadata=read`), in words: “Contents: write or Metadata: read”. Anything else stays unsaid.
 */
export function formatGithubPermissionsV1(
  detail: string | undefined,
  t: ReturnType<typeof usePluginTranslation>,
): string | null {
  if (!detail) return null;
  const sets = detail.split(';').map((set) => set.split(',').map((entry) => /^\s*([a-z_]+)=(read|write|admin)\s*$/u.exec(entry)));
  if (sets.some((set) => set.some((entry) => entry === null))) return null;
  const words = sets.map((set) => set.map((entry) => {
    const name = entry![1]!.replace(/_/gu, ' ');
    return `${name.charAt(0).toLocaleUpperCase()}${name.slice(1)}: ${entry![2]}`;
  }).join(', '));
  return words.reduce((all, next) => t('plugins.github.releases.permissions.or', '{first} or {second}', { first: all, second: next }));
}

export function formatReleaseTargetV1(target: string): string {
  return /^[0-9a-f]{40}$/iu.test(target) ? target.slice(0, 7) : target;
}

export function ReleaseMarks(
  props: Readonly<{
    release: ForgeReleaseV1;
    latest: boolean;
    immutable?: boolean;
  }>,
): React.ReactElement | null {
  const t = usePluginTranslation();
  const marks: React.ReactElement[] = [];
  if (props.release.draft)
    marks.push(
      <Badge
        key="draft"
        value={t('plugins.github.releases.mark.draft', 'Draft')}
      />,
    );
  else if (props.release.prerelease)
    marks.push(
      <Badge
        key="pre"
        value={t('plugins.github.releases.mark.prerelease', 'Pre-release')}
      />,
    );
  if (props.latest)
    marks.push(
      <Badge
        key="latest"
        value={t('plugins.github.releases.mark.latest', 'Latest')}
      />,
    );
  if (props.immutable && props.release.immutable === true)
    marks.push(
      <Badge
        key="immutable"
        value={t('plugins.github.releases.mark.immutable', 'Immutable')}
      />,
    );
  return marks.length === 0 ? null : (
    <Row gap="small" align="center">
      {marks}
    </Row>
  );
}

/** Notes at reading width, clipped with “Show all notes” when they run long. */
export function ReleaseNotes(
  props: Readonly<{ body: string | null; clip?: boolean; testID?: string }>,
): React.ReactElement {
  const t = usePluginTranslation();
  const theme = usePluginTheme();
  const [open, setOpen] = React.useState(false);
  const [height, setHeight] = React.useState(0);
  const body = props.body?.trim() ?? '';
  if (body === '')
    return (
      <Text
        tone="muted"
        value={t(
          'plugins.github.releases.notes.none',
          'No notes were written for this release.',
        )}
      />
    );
  const long = props.clip === true && height > NOTES_CLIP_PX + 24;
  const clipped = long && !open;
  return (
    <Stack gap="small" testID={props.testID} style={{ maxWidth: 704 }}>
      <Stack
        gap="none"
        style={
          clipped ? { maxHeight: NOTES_CLIP_PX, overflow: 'hidden' } : undefined
        }
      >
        <Stack
          gap="none"
          onLayout={(event) => setHeight(event.nativeEvent.layout.height)}
        >
          <Markdown value={body} />
        </Stack>
      </Stack>
      {long ? (
        <Row>
          <Button
            variant="plain"
            size="small"
            onPress={() => setOpen((value) => !value)}
            title={
              open
                ? t('plugins.github.releases.notes.less', 'Show less')
                : t('plugins.github.releases.notes.all', 'Show all notes')
            }
            icon={<Icon name={open ? 'back' : 'forward'} size="small" />}
          />
        </Row>
      ) : null}
      {clipped ? (
        <Stack
          gap="none"
          style={{ height: 1, backgroundColor: theme.colors.divider }}
        />
      ) : null}
    </Stack>
  );
}

/** Who published it and when, the tag's commit target and the provider's immutable fact, on one quiet line. */
export function ReleaseByline(
  props: Readonly<{ release: ForgeReleaseV1; locale: string }>,
): React.ReactElement {
  const t = usePluginTranslation();
  const { release } = props;
  const day = formatReleaseDayV1(
    release.draft
      ? (release.updatedAt ?? release.createdAt)
      : (release.publishedAt ?? release.createdAt),
    props.locale,
  );
  const author = release.author;
  const line = release.draft
    ? author
      ? t(
          'plugins.github.releases.byline.savedBy',
          'Saved on GitHub {day} by {author}',
          { day: day ?? '', author },
        )
      : t('plugins.github.releases.byline.saved', 'Saved on GitHub {day}', {
          day: day ?? '',
        })
    : author
      ? t(
          'plugins.github.releases.byline.publishedBy',
          'Published {day} by {author}',
          { day: day ?? '', author },
        )
      : t('plugins.github.releases.byline.published', 'Published {day}', {
          day: day ?? '',
        });
  return (
    <Row gap="small" align="center" wrap>
      {author ? <Avatar name={author} size="small" /> : null}
      <Text variant="meta" tone="secondary" value={line} />
      <Text variant="meta" tone="muted" value="·" />
      <Text
        variant="code"
        tone="secondary"
        value={formatReleaseTargetV1(release.targetCommitish)}
      />
      {release.immutable === true ? (
        <>
          <Text variant="meta" tone="muted" value="·" />
          <Badge
            value={t('plugins.github.releases.mark.immutable', 'Immutable')}
          />
        </>
      ) : null}
    </Row>
  );
}

export function ReleaseHeadline(
  props: Readonly<{
    release: ForgeReleaseV1;
    latest: boolean;
    size?: 'hero' | 'row';
  }>,
): React.ReactElement {
  const { release } = props;
  const t = usePluginTranslation();
  const { name, tagName } = projectGithubReleaseIdentityV1(release);
  const hero = props.size !== 'row';
  return (
    <Row gap="small" align="center" wrap>
      {name ? (
        <>
          {tagName === null ? null : <Text variant="code" value={tagName} />}
          <Text variant={hero ? 'title' : 'label'} value={name} />
        </>
      ) : (
        <Text variant={hero ? 'title' : 'label'} value={tagName ?? t('plugins.github.releases.draft.unnamed', 'Draft release')} />
      )}
      <ReleaseMarks release={release} latest={props.latest} />
    </Row>
  );
}

function sumDownloads(rows: readonly ForgeReleaseAssetV1[]): number | null {
  let total = 0;
  for (const row of rows) {
    if (row.downloadCount === undefined) return null;
    total += row.downloadCount;
  }
  return total;
}

/**
 * What a download that did not finish says, in the asset's own row: the receiver's reason is the substance, so it
 * stays its own text. Failed can be tried again (the Download control stays live); unknown never is, because the
 * answer was lost and the bytes may already be saved. Accepted, completed and a cancel the person chose say nothing.
 */
function AssetDownloadNotice(
  props: Readonly<{ result: ReleaseAssetDownloadV1['result'] }>,
): React.ReactElement | null {
  const t = usePluginTranslation();
  const result = props.result;
  if (!result || result.success) return null;
  if (result.status === 'failed') {
    return (
      <Row gap="small" wrap>
        <Text
          variant="meta"
          tone="danger"
          value={t(
            'plugins.github.releases.assets.downloadFailed',
            'Couldn’t save to this device.',
          )}
        />
        <Text
          variant="meta"
          tone="muted"
          value={
            result.error ||
            t(
              'plugins.github.releases.assets.downloadFailedRetry',
              'Nothing was saved. You can try again.',
            )
          }
        />
      </Row>
    );
  }
  if (result.status === 'unknown') {
    return (
      <Row gap="small" wrap>
        <Text
          variant="meta"
          tone="attention"
          value={t(
            'plugins.github.releases.assets.downloadUnknown',
            'Result unknown.',
          )}
        />
        {result.error ? (
          <Text variant="meta" tone="muted" value={result.error} />
        ) : null}
        <Text
          variant="meta"
          tone="muted"
          value={t(
            'plugins.github.releases.assets.downloadUnknownBody',
            'Check your downloads; Happier won’t ask again.',
          )}
        />
      </Row>
    );
  }
  return null;
}

/** Assets as a quiet table: name, size and downloads in one right-aligned tabular column, then Download. */
export function ReleaseAssets(
  props: Readonly<{
    release: ForgeReleaseV1;
    locale: string;
    compact?: boolean;
    downloads: ReadonlyMap<string, ReleaseAssetDownloadV1>;
    onDownload(asset: ForgeReleaseAssetV1): void;
    onShowAll?: () => void;
  }>,
): React.ReactElement {
  const t = usePluginTranslation();
  const theme = usePluginTheme();
  const rows = props.release.assets.rows;
  const numbers = React.useMemo(
    () => new Intl.NumberFormat(props.locale),
    [props.locale],
  );
  const total = sumDownloads(rows);
  const partial =
    props.release.assets.continuation !== null ||
    props.release.assets.incomplete !== null;
  if (rows.length === 0 && !partial) {
    return (
      <Row gap="small" align="center">
        <Text
          tone="muted"
          value={t(
            'plugins.github.releases.assets.none',
            'No assets, only the source code archives GitHub adds.',
          )}
        />
      </Row>
    );
  }
  return (
    <Stack gap="none">
      <Row
        gap="small"
        align="center"
        justify="space-between"
        style={{ paddingBottom: theme.spacing.small }}
      >
        <Row gap="small" align="center">
          <Text
            variant="label"
            value={t('plugins.github.releases.assets.title', 'Assets')}
          />
          <Text
            variant="label"
            tone="muted"
            value={numbers.format(rows.length)}
          />
        </Row>
        {!props.compact ? (
          <Text
            variant="meta"
            tone="muted"
            value={
              total === null
                ? t(
                    'plugins.github.releases.assets.plusSource',
                    'plus source code',
                  )
                : t(
                    'plugins.github.releases.assets.plusSourceDownloads',
                    'plus source code · {count} downloads',
                    { count: numbers.format(total) },
                  )
            }
          />
        ) : null}
      </Row>
      {rows.map((asset) => {
        const state = props.downloads.get(asset.assetId);
        return (
          <Row
            key={asset.assetId}
            gap="medium"
            align="center"
            style={{
              minHeight: 40,
              borderTopWidth: 1,
              borderColor: theme.colors.divider,
            }}
          >
            <Icon name="asset" size="small" tone="muted" />
            <Stack grow gap="none" style={{ minWidth: 0 }}>
              <Text variant="code" value={asset.name} numberOfLines={1} />
              <AssetDownloadNotice result={state?.result ?? null} />
            </Stack>
            <Text
              variant="meta"
              tone="secondary"
              value={formatHappierDataBytes(asset.size, {
                kind: 'storage',
                locale: props.locale,
              })}
            />
            {!props.compact && asset.downloadCount !== undefined ? (
              <Text
                variant="meta"
                tone="muted"
                value={
                  asset.downloadCount === 1
                    ? t(
                        'plugins.github.releases.assets.downloadsOne',
                        '{count} download',
                        { count: numbers.format(asset.downloadCount) },
                      )
                    : t(
                        'plugins.github.releases.assets.downloads',
                        '{count} downloads',
                        { count: numbers.format(asset.downloadCount) },
                      )
                }
              />
            ) : null}
            {state?.pending ? (
              <Stack gap="none" style={{ width: 32, alignItems: 'center' }}>
                <Spinner size="small" />
              </Stack>
            ) : (
              <IconButton
                accessibilityLabel={t(
                  'plugins.github.releases.assets.download',
                  'Download {name}',
                  { name: asset.name },
                )}
                icon={
                  <Icon
                    name={state?.result?.status === 'completed' ? 'check' : 'download'}
                    size="small"
                  />
                }
                onPress={() => props.onDownload(asset)}
                disabled={state?.result?.status === 'unknown' || state?.result?.status === 'accepted'}
              />
            )}
          </Row>
        );
      })}
      {partial && props.onShowAll ? (
        <Row
          style={{
            borderTopWidth: 1,
            borderColor: theme.colors.divider,
            paddingTop: theme.spacing.small,
          }}
        >
          <ReleaseEdgeAligned>
            <Button
              variant="plain"
              size="small"
              title={t(
                'plugins.github.releases.assets.showAll',
                'Show all assets',
              )}
              onPress={props.onShowAll}
            />
          </ReleaseEdgeAligned>
        </Row>
      ) : null}
    </Stack>
  );
}
