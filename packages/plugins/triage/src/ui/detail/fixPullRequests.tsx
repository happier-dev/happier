import * as React from 'react';

import {
  Button,
  ErrorState,
  Item,
  ItemGroup,
  Label,
  LoadingState,
  Menu,
  Stack,
  Status,
  usePluginTranslation,
} from '@happier-dev/plugin-ui';
import type { TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';

import type { TriageFixPullRequestV1 } from '../../corpus/marks/fixPullRequests.js';
import type { TriageFixPullRequestsStateV1 } from './useTriageFixPullRequests.js';

/** A pull request the reader can pick, as their projection renders it. */
export type TriageFixPullRequestPickV1 = Readonly<{
  entryRef: TriageEntryRefV1;
  title: string;
  scopeLabel: string;
}>;

function refKey(ref: TriageEntryRefV1): string {
  return [ref.source.pluginId, ref.source.localId, ref.kindId, ref.collisionScope, ref.entryId].join('\u001f');
}

type Text = ReturnType<typeof usePluginTranslation>;

function statusDetail(candidate: TriageFixPullRequestV1, text: Text): string | undefined {
  switch (candidate.status) {
    case 'open':
      return text('plugins.triage.surface.detail.fixPr.open', 'Open');
    case 'merged':
      return text('plugins.triage.surface.detail.fixPr.merged', 'Merged');
    case 'closed':
      return text('plugins.triage.surface.detail.fixPr.closed', 'Closed without merging');
    default:
      return undefined;
  }
}

/**
 * The issue or error group's fix pull requests, and the "Link fix PR" control.
 *
 * It renders the owner's ranked answer and nothing else: which PR the Files and
 * Checks tabs use is `state.primary`, decided by `resolveFixPullRequests`. A PR
 * closed without merging stays listed so the reader can unlink it, and says so
 * in words. The detail supplies `pickable` from its own projection, because the
 * PRs a reader can name are the ones their list already shows.
 */
export function TriageFixPullRequests(props: Readonly<{
  state: TriageFixPullRequestsStateV1;
  pickable: readonly TriageFixPullRequestPickV1[];
}>): React.ReactElement {
  const text = usePluginTranslation();
  const [menuOpen, setMenuOpen] = React.useState(false);
  const { state } = props;
  if (state.kind === 'reading') {
    return <LoadingState titleKey="plugins.triage.surface.detail.fixPr.title" title="Fix pull request" />;
  }
  if (state.kind === 'unreachable') {
    return <ErrorState
      titleKey="plugins.triage.surface.detail.fixPr.readFailed"
      title="Fix pull request links could not be read."
      action={<Button titleKey="plugins.triage.surface.actions.retry" title="Retry"
        accessibilityLabel={`${text('plugins.triage.surface.actions.retry', 'Retry')}: ${text('plugins.triage.surface.detail.fixPr.title', 'Fix pull request')}`}
        variant="secondary" onPress={state.retry} />}
    />;
  }
  const linkedKeys = new Set(state.candidates.map((candidate) => refKey(candidate.entryRef)));
  const offers = props.pickable.filter((pick) => !linkedKeys.has(refKey(pick.entryRef)));
  const heading = text('plugins.triage.surface.detail.fixPr.title', 'Fix pull request');
  const linkLabel = text('plugins.triage.surface.detail.fixPr.link', 'Link fix PR');

  return (
    <Stack gap="small">
      <Label value={heading} />
      {state.candidates.length > 0 ? (
        <ItemGroup accessibilityLabel={heading}>
          {state.candidates.map((candidate) => {
            const title = candidate.display.title
              ?? candidate.display.displayPath
              ?? candidate.entryRef.entryId;
            const detail = statusDetail(candidate, text);
            const unlinkLabel = text('plugins.triage.surface.detail.fixPr.unlink', 'Unlink');
            return (
              <Item
                key={refKey(candidate.entryRef)}
                title={title}
                {...(candidate.display.scopeLabel === undefined ? {} : { subtitle: candidate.display.scopeLabel })}
                {...(detail === undefined ? {} : { detail })}
                accessibilityLabel={title}
                accessoryOutsidePressable
                accessory={(
                  <Button
                    title={unlinkLabel}
                    accessibilityLabel={`${unlinkLabel} ${title}`}
                    variant="secondary"
                    disabled={state.busy}
                    onPress={() => state.unlink(candidate.entryRef)}
                  />
                )}
              />
            );
          })}
        </ItemGroup>
      ) : null}
      {offers.length > 0 ? (
        <Menu
          open={menuOpen}
          onOpenChange={setMenuOpen}
          trigger={linkLabel}
          triggerAccessibilityLabel={linkLabel}
          triggerAppearance="control"
          items={offers.map((offer) => ({ id: refKey(offer.entryRef), label: offer.title }))}
          onSelect={(id) => {
            const offer = offers.find((candidate) => refKey(candidate.entryRef) === id);
            if (offer === undefined || state.busy) return;
            state.link({ entryRef: offer.entryRef, display: { title: offer.title, scopeLabel: offer.scopeLabel } });
          }}
        />
      ) : null}
      {state.refusal === 'conflict' ? (
        <Status
          tone="warning"
          labelKey="plugins.triage.surface.detail.fixPr.conflict"
          label="That link was changed somewhere else. Showing the current state."
        />
      ) : state.refusal === 'failed' ? (
        <Status
          tone="danger"
          labelKey="plugins.triage.surface.detail.fixPr.failed"
          label="Happier cannot reach your account right now, so the link was not changed."
        />
      ) : null}
      {state.incomplete ? (
        <Status
          tone="neutral"
          labelKey="plugins.triage.surface.detail.fixPr.incomplete"
          label="Some linked sessions were not checked for pull requests."
        />
      ) : null}
    </Stack>
  );
}
