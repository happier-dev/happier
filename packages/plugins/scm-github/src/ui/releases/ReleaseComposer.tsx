import * as React from 'react';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import {
  Banner,
  Button,
  Field,
  Icon,
  IconButton,
  Markdown,
  MarkdownEditor,
  Row,
  Select,
  Stack,
  Text,
  TextField,
  Toggle,
  usePluginTheme,
  usePluginTranslation,
} from '@happier-dev/plugin-ui';
import type {
  ForgeReleaseActionInputByOperationV1,
  ForgeReleaseMountedCommandV1,
} from '@happier-dev/triage-protocol/releases/v1';
import {
  type ReleaseEditorOperationV1,
  type ReleaseEditorV1,
} from './editor.js';
import {
  useReleaseEditorSnapshotV1,
} from './hooks.js';
import type { ReleaseAssetDownloadsV1 } from './downloads.js';
import type { useReleaseDetailV1 } from './detail.js';
import { formatGithubPermissionsV1, formatReleaseDayV1, ReleaseAssets, ReleaseEdgeAligned, ReleaseSessionHelpButton, type ReleaseSessionHelpV1 } from './ReleaseStory.js';

/**
 * The release editor (lab b2). Draft release grows the Next release card into this sheet in place.
 * The flow is explicit and honest: Generate is an unsaved proposal applied with Use or Replace; nothing
 * reaches GitHub until Save draft; Publish is separate, reviews the saved draft afresh and confirms once
 * through the host. The sheet says “Not saved” or “Unsaved changes” until a real Save receipt.
 * Assets have no upload here; a saved draft's existing assets list and download, and “Manage assets on
 * GitHub” is ordinary external navigation.
 */

type Target = ForgeReleaseActionInputByOperationV1['readLatestRelease'];
type Host = Pick<PluginUiHostApi, 'downloadFile' | 'openExternalLink'>;
type Field =
  | 'tagName'
  | 'targetCommitish'
  | 'previousTagName'
  | 'name'
  | 'body';

const EDITOR_HEIGHT = 300;

/**
 * One switch with its name and consequence. Wide: the switch leads and the name and consequence share its line.
 * Phone: the name and consequence stack on the left and the switch sits on the right edge, like a settings row.
 */
function OptionRow(
  props: Readonly<{
    phone: boolean;
    label: string;
    hint: string;
    muted?: boolean;
    toggle: React.ReactElement;
  }>,
): React.ReactElement {
  const tone = props.muted ? 'muted' : 'neutral';
  if (props.phone)
    return (
      <Row gap="medium" align="center" justify="space-between">
        <Stack grow gap="none" style={{ minWidth: 0 }}>
          <Text variant="label" tone={tone} value={props.label} />
          <Text variant="meta" tone="muted" value={props.hint} />
        </Stack>
        {props.toggle}
      </Row>
    );
  return (
    <Row gap="small" align="center" wrap>
      {props.toggle}
      <Text variant="label" tone={tone} value={props.label} />
      <Text variant="meta" tone="muted" value={props.hint} />
    </Row>
  );
}

/** The empty editor's three ways to start: a row on a wide page, a column across the sheet on a phone. */
function NotesStartActions(props: Readonly<{ phone: boolean; children: React.ReactNode }>): React.ReactElement {
  return props.phone ? (
    <Stack gap="small" align="stretch" style={{ alignSelf: 'stretch' }}>{props.children}</Stack>
  ) : (
    <Row gap="small" wrap justify="center">{props.children}</Row>
  );
}

export function ReleaseComposer(
  props: Readonly<{
    target: Target;
    host: Host;
    assetDownloads: ReleaseAssetDownloadsV1;
    sessionHelp: ReleaseSessionHelpV1 | undefined;
    locale: string;
    phone: boolean;
    editor: ReleaseEditorV1 | null;
    previousTag: string;
    /** The page's operandless controls (close, discard, keep editing, use GitHub's version, check status, generate). */
    onCommand(command: ForgeReleaseMountedCommandV1): void;
    onOpenGithub(url: string): void;
    onSignIn(): void;
    loadMoreAssets: ReturnType<typeof useReleaseDetailV1>['loadMoreAssets'];
  }>,
): React.ReactElement {
  const editor = props.editor;
  const snapshot = useReleaseEditorSnapshotV1(editor);
  if (!editor || !snapshot)
    return <Stack gap="none" style={{ minHeight: 120 }} />;
  return <ComposerSheet {...props} editor={editor} snapshot={snapshot} />;
}

function ComposerSheet(
  props: Readonly<{
    editor: ReleaseEditorV1;
    snapshot: NonNullable<ReturnType<typeof useReleaseEditorSnapshotV1>>;
    target: Target;
    host: Host;
    assetDownloads: ReleaseAssetDownloadsV1;
    sessionHelp: ReleaseSessionHelpV1 | undefined;
    locale: string;
    phone: boolean;
    previousTag: string;
    onCommand(command: ForgeReleaseMountedCommandV1): void;
    onOpenGithub(url: string): void;
    onSignIn(): void;
    loadMoreAssets: ReturnType<typeof useReleaseDetailV1>['loadMoreAssets'];
  }>,
): React.ReactElement {
  const t = usePluginTranslation();
  const theme = usePluginTheme();
  const { editor, snapshot } = props;
  const { fields, saved, dirty, busy, failure, outcome, conflict, proposal } =
    snapshot;
  const [lastWrite, setLastWrite] =
    React.useState<ReleaseEditorOperationV1 | null>(null);
  // The unsaved-change guard lives on the editor, so the mounted Action answers the same question.
  const confirmDiscard = snapshot.closing;
  const downloads = props.assetDownloads.state;
  const set = (field: Field, value: string) => {
    void editor.invoke({ kind: 'setField', field, value });
  };
  const unknown = outcome?.kind === 'outcome_unknown';
  const published = saved !== null && !saved.draft;
  const clean = saved !== null && !dirty;
  const signInExpired = failure?.class === 'authentication';
  const writeBlocked = unknown || signInExpired || busy !== null;
  const savedAt = saved
    ? formatReleaseDayV1(saved.updatedAt ?? saved.createdAt, props.locale)
    : null;
  const status = clean
    ? t('plugins.github.releases.compose.status.saved', 'Draft saved {day}', {
        day: savedAt ?? '',
      })
    : saved
      ? t('plugins.github.releases.compose.status.unsaved', 'Unsaved changes')
      : t('plugins.github.releases.compose.status.notSaved', 'Not saved');

  const save = async () => {
    setLastWrite(saved ? 'editReleaseDraft' : 'createReleaseDraft');
    await editor.save();
  };
  const publish = async () => {
    setLastWrite('publishReleaseDraft');
    await editor.reviewPublish();
    if (editor.getSnapshot()?.review) await editor.publishDraft();
  };
  const close = () => props.onCommand('close');

  const unknownCopy =
    lastWrite === 'publishReleaseDraft'
      ? t(
          'plugins.github.releases.compose.unknown.publish',
          'Publish {tag} was sent, but GitHub’s answer never arrived, so it may already be public.',
          { tag: fields.tagName },
        )
      : lastWrite === 'editReleaseDraft' || saved
        ? t(
            'plugins.github.releases.compose.unknown.save',
            'Your changes to the {tag} draft were sent, but GitHub’s answer never arrived, so the draft may still hold the earlier version.',
            { tag: fields.tagName },
          )
        : t(
            'plugins.github.releases.compose.unknown.create',
            'Save draft for {tag} was sent, but GitHub’s answer never arrived, so the draft may or may not exist yet.',
            { tag: fields.tagName },
          );

  const notice = signInExpired ? (
    <Banner
      tone="warning"
      title={t(
        'plugins.github.releases.compose.signIn.title',
        'Sign in to GitHub again',
      )}
      description={t(
        'plugins.github.releases.compose.signIn.body',
        'The GitHub sign-in expired before this reached GitHub. Nothing was saved, and the tag, name and notes below stay as they are.',
      )}
      action={
        <Button
          size="small"
          title={t(
            'plugins.github.releases.state.signIn.action',
            'Sign in again',
          )}
          onPress={props.onSignIn}
        />
      }
    />
  ) : unknown ? (
    <Banner
      tone="warning"
      title={t(
        'plugins.github.releases.compose.unknown.title',
        'Result unknown — check on GitHub',
      )}
      description={unknownCopy}
      action={
        <Row gap="small">
          {outcome?.kind === 'outcome_unknown' && outcome.releaseId ? (
            <Button
              size="small"
              variant="secondary"
              title={t(
                'plugins.github.releases.compose.unknown.check',
                'Check status',
              )}
              onPress={() => props.onCommand('checkStatus')}
            />
          ) : null}
          <Button
            size="small"
            variant="plain"
            title={t(
              'plugins.github.releases.compose.openGithub',
              'Open on GitHub',
            )}
            onPress={() =>
              props.onOpenGithub(
                outcome?.kind === 'outcome_unknown' && outcome.webUrl
                  ? outcome.webUrl
                  : `${props.target.repository.deployment.replace(/\/$/u, '')}/${props.target.repository.repository}/releases`,
              )
            }
          />
        </Row>
      }
    />
  ) : conflict ? (
    <Banner
      tone="danger"
      title={
        lastWrite === 'publishReleaseDraft'
          ? t(
              'plugins.github.releases.compose.conflict.publishTitle',
              'This draft changed on GitHub since you reviewed it',
            )
          : t(
              'plugins.github.releases.compose.conflict.title',
              'This draft changed on GitHub since you opened it',
            )
      }
      description={
        lastWrite === 'publishReleaseDraft'
          ? t(
              'plugins.github.releases.compose.conflict.publishBody',
              'Nothing was published. Review GitHub’s version, then publish again.',
            )
          : t(
              'plugins.github.releases.compose.conflict.body',
              'Your edits are kept here and nothing was overwritten. Review GitHub’s version before saving.',
            )
      }
      action={
        <Button
          size="small"
          variant="secondary"
          title={t(
            'plugins.github.releases.compose.conflict.useRemote',
            'Use GitHub’s version',
          )}
          onPress={() => props.onCommand('useRemote')}
        />
      }
    />
  ) : null;

  const footNote = (() => {
    if (signInExpired)
      return {
        icon: 'denied' as const,
        text: t(
          'plugins.github.releases.compose.foot.signIn',
          'Not saved · sign in again to save to GitHub',
        ),
        tone: 'secondary' as const,
      };
    if (unknown)
      return {
        icon: 'locked' as const,
        text: t(
          'plugins.github.releases.compose.foot.unknown',
          'Waiting on the result · nothing will be sent again on its own',
        ),
        tone: 'secondary' as const,
      };
    if (failure?.class === 'rateLimit')
      return {
        icon: 'waiting' as const,
        text:
          failure.retryNotBeforeMs === undefined
            ? t(
                'plugins.github.releases.compose.foot.rateNoTime',
                'GitHub is briefly limiting requests. Your notes stay here; saving waits.',
              )
            : t(
                'plugins.github.releases.compose.foot.rate',
                'GitHub resets the limit at {time}. Your notes stay here.',
                {
                  time: new Intl.DateTimeFormat(props.locale, {
                    hour: 'numeric',
                    minute: '2-digit',
                  }).format(failure.retryNotBeforeMs),
                },
              ),
        tone: 'secondary' as const,
      };
    if (failure?.class === 'permission') {
      // GitHub's own answer about what the sign-in lacks, from the refused write; the notes stay local.
      const permissions = formatGithubPermissionsV1(failure.detail, t);
      return {
        icon: 'denied' as const,
        text: permissions === null
          ? t(
              'plugins.github.releases.compose.foot.permission',
              'GitHub refused this with the current sign-in. Your notes stay here; nothing was saved.',
            )
          : t(
              'plugins.github.releases.compose.foot.permissionRequires',
              'GitHub requires {permissions} to save this release. Your notes stay here; nothing was saved.',
              { permissions },
            ),
        tone: 'danger' as const,
      };
    }
    if (failure)
      return {
        icon: 'failure' as const,
        text: t(
          'plugins.github.releases.compose.foot.failed',
          'GitHub didn’t take this. Your notes stay here; nothing was saved.',
        ),
        tone: 'danger' as const,
      };
    if (clean)
      return {
        icon: 'locked' as const,
        text: t(
          'plugins.github.releases.compose.foot.saved',
          'Saved on GitHub {day} · only people with write access see it',
          { day: savedAt ?? '' },
        ),
        tone: 'secondary' as const,
      };
    return {
      icon: 'locked' as const,
      text: saved
        ? t(
            'plugins.github.releases.compose.foot.unsaved',
            'You have unsaved changes · the GitHub draft is as you last saved it',
          )
        : t(
            'plugins.github.releases.compose.foot.notSaved',
            'Not saved · nothing is on GitHub yet',
          ),
      tone: 'secondary' as const,
    };
  })();

  const generating = busy === 'generateReleaseNotes';
  const notesStart = fields.body === '' && !generating && !proposal;
  const proposalPanel = proposal ? (
    <Stack
      gap="small"
      style={{
        padding: theme.spacing.medium,
        borderRadius: theme.radii.control,
        backgroundColor: theme.colors.surface,
        borderWidth: 1,
        borderColor: theme.colors.border,
      }}
      testID="github-release-proposal"
    >
      <Row gap="small" align="center">
        <Icon name="generate" size="small" tone="secondary" />
        <Text
          variant="label"
          value={t(
            'plugins.github.releases.compose.proposal.title',
            'GitHub’s notes for the changes since {tag}',
            { tag: fields.previousTagName || props.previousTag },
          )}
        />
      </Row>
      <Stack gap="none" style={{ maxHeight: 220, overflow: 'hidden' }}>
        <Markdown value={proposal.body} />
      </Stack>
      <Row gap="small" align="center" wrap>
        <Text
          variant="meta"
          tone="muted"
          value={t(
            'plugins.github.releases.compose.proposal.note',
            'A proposal: nothing changes until you choose.',
          )}
        />
        <Stack grow gap="none" />
        {fields.body === '' && fields.name === '' ? (
          <Button
            size="small"
            title={t(
              'plugins.github.releases.compose.proposal.use',
              'Use these notes',
            )}
            onPress={() => {
              void editor.invoke({ kind: 'applyGenerated', mode: 'use' });
            }}
          />
        ) : (
          <Button
            size="small"
            title={t(
              'plugins.github.releases.compose.proposal.replace',
              'Replace my notes',
            )}
            onPress={() => {
              void editor.invoke({ kind: 'applyGenerated', mode: 'replace' });
            }}
          />
        )}
      </Row>
    </Stack>
  ) : null;

  const fieldsGrid = (
    <Row gap="medium" align="flex-start" wrap>
      <Stack
        grow
        gap="xsmall"
        style={{ minWidth: props.phone ? '100%' : 150, flexBasis: 0 }}
      >
        <Field label={t('plugins.github.releases.compose.tag', 'Tag')}>
          <TextField
            label={t('plugins.github.releases.compose.tag', 'Tag')}
            value={fields.tagName}
            onChange={(value) => set('tagName', value)}
            autoCapitalize="none"
            autoCorrect={false}
            disabled={published}
            testID="github-release-tag"
          />
        </Field>
        <Text
          variant="meta"
          tone="muted"
          value={
            props.previousTag
              ? t(
                  'plugins.github.releases.compose.tag.hint',
                  'Next after {tag}',
                  { tag: props.previousTag },
                )
              : t(
                  'plugins.github.releases.compose.tag.hintFirst',
                  'A new tag, created when you publish',
                )
          }
        />
      </Stack>
      <Stack
        grow
        gap="xsmall"
        style={{ minWidth: props.phone ? '100%' : 150, flexBasis: 0 }}
      >
        <Field label={t('plugins.github.releases.compose.target', 'Created from')}>
          <TextField
            label={t('plugins.github.releases.compose.target', 'Created from')}
            value={fields.targetCommitish}
            onChange={(value) => set('targetCommitish', value)}
            autoCapitalize="none"
            autoCorrect={false}
            disabled={published}
          />
        </Field>
        <Text
          variant="meta"
          tone="muted"
          value={t(
            'plugins.github.releases.compose.target.hint',
            'The tag is created when you publish',
          )}
        />
      </Stack>
      {!props.phone ? (
        <Stack grow gap="xsmall" style={{ minWidth: 150, flexBasis: 0 }}>
          <Field label={t('plugins.github.releases.compose.since', 'Changes since')}>
            <TextField
              label={t('plugins.github.releases.compose.since', 'Changes since')}
              value={fields.previousTagName}
              onChange={(value) => set('previousTagName', value)}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </Field>
          <Text
            variant="meta"
            tone="muted"
            value={t(
              'plugins.github.releases.compose.since.hint',
              'GitHub generates the notes from the changes since this tag',
            )}
          />
        </Stack>
      ) : null}
    </Row>
  );

  const editorBlock = (
    <Stack
      gap="none"
      style={{
        borderRadius: theme.radii.control,
        borderWidth: 1,
        borderColor: theme.colors.border,
        overflow: 'hidden',
      }}
    >
      <Row
        gap="small"
        align="center"
        style={{
          paddingHorizontal: theme.spacing.small,
          paddingVertical: theme.spacing.xsmall,
          borderBottomWidth: 1,
          borderColor: theme.colors.divider,
        }}
      >
        <Stack gap="none" style={{ width: 180 }}>
          <Select
            presentation="segmented"
            label={t('plugins.github.releases.compose.mode', 'Notes view')}
            value={snapshot.preview ? 'preview' : 'write'}
            options={[
              {
                value: 'write',
                label: t('plugins.github.releases.compose.write', 'Write'),
              },
              {
                value: 'preview',
                label: t('plugins.github.releases.compose.preview', 'Preview'),
              },
            ]}
            onChange={(value) => {
              void editor.invoke({
                kind: 'setPreview',
                value: value === 'preview',
              });
            }}
          />
        </Stack>
        <Stack grow gap="none" />
        {!props.phone ? (
          <Text
            variant="meta"
            tone="muted"
            value={t('plugins.github.releases.compose.markdown', 'Markdown')}
          />
        ) : null}
        {fields.body !== '' || proposal ? (
          props.phone ? (
            <IconButton
              busy={generating}
              disabled={(writeBlocked && !generating) || !fields.tagName.trim()}
              icon={<Icon name="generate" size="small" />}
              accessibilityLabel={t(
                'plugins.github.releases.compose.regenerate',
                'Regenerate',
              )}
              onPress={() => props.onCommand('generate')}
            />
          ) : (
            <Button
              size="small"
              variant="plain"
              busy={generating}
              disabled={(writeBlocked && !generating) || !fields.tagName.trim()}
              icon={<Icon name="generate" size="small" />}
              title={t(
                'plugins.github.releases.compose.regenerate',
                'Regenerate',
              )}
              onPress={() => props.onCommand('generate')}
            />
          )
        ) : null}
      </Row>
      <Stack gap="none" style={{ height: EDITOR_HEIGHT }}>
        {generating && fields.body === '' ? (
          <Stack gap="small" style={{ padding: theme.spacing.large }}>
            <Row gap="small" align="center">
              <Icon name="generate" size="small" tone="secondary" />
              <Text
                variant="meta"
                tone="secondary"
                value={t(
                  'plugins.github.releases.compose.generating',
                  'Generating notes since {tag}…',
                  { tag: fields.previousTagName || props.previousTag },
                )}
              />
            </Row>
            {[38, 82, 76, 88, 70, 64].map((width, index) => (
              <Stack
                key={index}
                gap="none"
                style={{
                  height: 10,
                  width: `${width}%`,
                  borderRadius: 5,
                  backgroundColor: theme.colors.elevatedSurface,
                }}
              />
            ))}
          </Stack>
        ) : notesStart && !snapshot.preview ? (
          <Stack
            gap="medium"
            align="center"
            justify="center"
            style={{ flex: 1, padding: theme.spacing.large }}
          >
            <Text
              variant="label"
              value={t(
                'plugins.github.releases.compose.start.title',
                'Start the notes',
              )}
            />
            <Stack gap="none" style={{ maxWidth: 460 }}>
              <Text
                tone="secondary"
                value={
                  props.previousTag
                    ? t(
                        'plugins.github.releases.compose.start.body',
                        'Write them yourself, or generate GitHub’s notes for the changes since {tag}. Nothing is saved to GitHub until you press Save draft.',
                        { tag: props.previousTag },
                      )
                    : t(
                        'plugins.github.releases.compose.start.bodyFirst',
                        'Write them yourself, or generate GitHub’s notes for the changes in this tag. Nothing is saved to GitHub until you press Save draft.',
                      )
                }
              />
            </Stack>
            <NotesStartActions phone={props.phone}>
              <Button
                variant="secondary"
                icon={<Icon name="generate" size="small" />}
                disabled={!fields.tagName.trim() || writeBlocked}
                title={t(
                  'plugins.github.releases.compose.generate',
                  'Generate from changes',
                )}
                onPress={() => props.onCommand('generate')}
              />
              <ReleaseSessionHelpButton
                help={props.sessionHelp}
                intent={{ kind: 'notes', releaseId: saved?.releaseId ?? null }}
              />
              <Button
                variant="plain"
                title={t(
                  'plugins.github.releases.compose.writeOwn',
                  'Write my own',
                )}
                onPress={() => {
                  void editor.invoke({
                    kind: 'setField',
                    field: 'body',
                    value: '## Highlights\n\n- ',
                  });
                }}
              />
            </NotesStartActions>
          </Stack>
        ) : snapshot.preview ? (
          <Stack
            gap="none"
            style={{
              padding: theme.spacing.large,
              flex: 1,
              overflow: 'hidden',
            }}
          >
            {fields.body.trim() === '' ? (
              <Text
                tone="muted"
                value={t(
                  'plugins.github.releases.compose.previewEmpty',
                  'Nothing to preview yet.',
                )}
              />
            ) : (
              <Markdown value={fields.body} />
            )}
          </Stack>
        ) : (
          <Stack gap="none" style={{ flex: 1, padding: theme.spacing.small }}>
            <MarkdownEditor
              presentation="document"
              accessibilityLabel={t(
                'plugins.github.releases.compose.notes',
                'Release notes',
              )}
              value={fields.body}
              onChange={(value) => set('body', value)}
              disabled={published}
              testID="github-release-notes"
            />
          </Stack>
        )}
      </Stack>
    </Stack>
  );

  const OptionsFrame = props.phone ? Stack : Row;
  const options = (
    <OptionsFrame {...(props.phone ? { gap: 'medium' as const } : { gap: 'xlarge' as const, align: 'center' as const, wrap: true })}>
      <OptionRow
        phone={props.phone}
        label={t('plugins.github.releases.compose.prerelease', 'Pre-release')}
        hint={t(
          'plugins.github.releases.compose.prerelease.hint',
          'Not ready for production',
        )}
        toggle={
          <Toggle
            label={t('plugins.github.releases.compose.prerelease', 'Pre-release')}
            value={fields.prerelease}
            onChange={(value) => {
              void editor.invoke({ kind: 'setPrerelease', value });
            }}
            disabled={published}
          />
        }
      />
      <OptionRow
        phone={props.phone}
        muted={fields.prerelease}
        label={t('plugins.github.releases.compose.latest', 'Set as latest')}
        hint={
          fields.prerelease
            ? t(
                'plugins.github.releases.compose.latest.pre',
                'Pre-releases never are',
              )
            : snapshot.makeLatest === 'legacy'
              ? t(
                  'plugins.github.releases.compose.latest.legacy',
                  'GitHub decides from the version and date',
                )
              : t(
                  'plugins.github.releases.compose.latest.hint',
                  'Shown as this repository’s latest release',
                )
        }
        toggle={
          <Toggle
            label={t('plugins.github.releases.compose.latest', 'Set as latest')}
            value={!fields.prerelease && snapshot.makeLatest === 'true'}
            onChange={(value) => {
              void editor.invoke({
                kind: 'setMakeLatest',
                value: value ? 'true' : 'false',
              });
            }}
            disabled={fields.prerelease || published}
          />
        }
      />
    </OptionsFrame>
  );

  const manageAssets = saved ? (
    <Button
      size="small"
      variant="plain"
      icon={<Icon name="external" size="small" />}
      title={t(
        'plugins.github.releases.compose.assets.manage',
        'Manage assets on GitHub',
      )}
      onPress={() => props.onOpenGithub(saved.webUrl)}
    />
  ) : null;

  const assets =
    saved && saved.assets.rows.length > 0 ? (
      <ReleaseAssets
        release={saved}
        locale={props.locale}
        compact={props.phone}
        downloads={downloads}
        onShowAll={() => { void props.loadMoreAssets(); }}
        onDownload={(asset) => {
          void props.assetDownloads.download(saved, asset);
        }}
      />
    ) : (
      <Stack gap="small">
        <Row gap="small" align={props.phone ? 'flex-start' : 'center'}>
          <Icon name="asset" size="small" tone="muted" />
          <Stack gap="none" style={{ flexShrink: 1, minWidth: 0 }}>
            <Text
              tone="secondary"
              value={
                saved
                  ? t(
                      'plugins.github.releases.compose.assets.none',
                      'No assets on this draft yet',
                    )
                  : t(
                      'plugins.github.releases.compose.assets.afterSave',
                      'Assets can be attached on GitHub once the draft is saved',
                    )
              }
            />
          </Stack>
          {props.phone ? null : <Stack grow gap="none" />}
          {saved && !props.phone ? manageAssets : null}
        </Row>
        {saved && props.phone ? <ReleaseEdgeAligned>{manageAssets}</ReleaseEdgeAligned> : null}
      </Stack>
    );

  const saveDisabled =
    writeBlocked ||
    published ||
    !fields.tagName.trim() ||
    !fields.targetCommitish.trim() ||
    (saved !== null && !dirty);
  const publishDisabled =
    writeBlocked || !clean || published || conflict !== null;
  const saveButton = (
    <Button
      variant={clean ? 'secondary' : 'primary'}
      busy={busy === 'createReleaseDraft' || busy === 'editReleaseDraft'}
      disabled={saveDisabled}
      title={t('plugins.github.releases.compose.save', 'Save draft')}
      onPress={() => {
        void save();
      }}
    />
  );
  const publishButton = (
    <Button
      variant={clean ? 'primary' : 'secondary'}
      busy={
        busy === 'publishReleaseDraft' ||
        busy === 'readRelease' ||
        busy === 'listAssets'
      }
      disabled={publishDisabled}
      icon={<Icon name="tag" size="small" />}
      title={t('plugins.github.releases.compose.publish', 'Publish…')}
      onPress={() => {
        void publish();
      }}
      accessibilityLabel={
        clean
          ? undefined
          : t(
              'plugins.github.releases.compose.publish.needsSave',
              'Publish, available after you save the draft',
            )
      }
    />
  );
  const footer = confirmDiscard ? (
    <Row gap="small" align="center" wrap>
      <Text
        tone="secondary"
        value={t(
          'plugins.github.releases.compose.discard.prompt',
          'Discard your unsaved changes? The GitHub draft stays as you last saved it.',
        )}
      />
      <Stack grow gap="none" />
      <Button
        variant="plain"
        title={t(
          'plugins.github.releases.compose.discard.keep',
          'Keep editing',
        )}
        onPress={() => props.onCommand('keepEditing')}
      />
      <Button
        variant="destructive"
        title={t('plugins.github.releases.compose.discard.confirm', 'Discard')}
        onPress={() => props.onCommand('discard')}
      />
    </Row>
  ) : (
    <Stack gap="small">
      <Row gap="small" align="center" wrap>
        <Row gap="small" align="center" style={{ flexShrink: 1, minWidth: 0 }}>
          <Icon
            name={footNote.icon}
            size="small"
            tone={footNote.tone === 'danger' ? 'danger' : 'muted'}
          />
          <Text variant="meta" tone={footNote.tone} value={footNote.text} />
        </Row>
        {props.phone ? null : (
          <>
            <Stack grow gap="none" />
            <Button
              variant="plain"
              title={t('plugins.github.releases.compose.cancel', 'Cancel')}
              onPress={close}
            />
            {saveButton}
            {publishButton}
          </>
        )}
      </Row>
      {props.phone ? (
        // A phone's two operations share the row equally, as the lab's pushed editor does.
        <Row gap="small" align="center">
          <Stack grow align="stretch">{saveButton}</Stack>
          <Stack grow align="stretch">{publishButton}</Stack>
        </Row>
      ) : null}
    </Stack>
  );

  return (
    <Stack
      gap="large"
      testID="github-release-composer"
      style={{
        borderRadius: theme.radii.panel,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface,
        padding: props.phone ? theme.spacing.medium : theme.spacing.large,
      }}
    >
      <Row gap="small" align="center">
        <Text
          variant="heading"
          value={
            saved
              ? t('plugins.github.releases.compose.titleDraft', 'Release draft')
              : t('plugins.github.releases.compose.title', 'New release')
          }
        />
        <Text variant="meta" tone="muted" value={status} />
        <Stack grow gap="none" />
        <IconButton
          accessibilityLabel={t(
            'plugins.github.releases.compose.close',
            'Close the editor',
          )}
          icon={<Icon name="close" size="small" />}
          onPress={close}
        />
      </Row>
      {notice}
      {fieldsGrid}
      <Field label={t('plugins.github.releases.compose.name', 'Release name')}>
        <TextField
          label={t('plugins.github.releases.compose.name', 'Release name')}
          value={fields.name}
          onChange={(value) => set('name', value)}
          placeholder={t(
            'plugins.github.releases.compose.name.placeholder',
            'Release name',
          )}
          disabled={published}
          testID="github-release-name"
        />
      </Field>
      {proposalPanel}
      {editorBlock}
      {options}
      {assets}
      {footer}
    </Stack>
  );
}
