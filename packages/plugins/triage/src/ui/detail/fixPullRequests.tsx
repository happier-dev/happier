import * as React from 'react';

import {
  Button,
  Item,
  ItemGroup,
  LoadingState,
  Menu,
  Stack,
  Status,
  Step,
  Text,
  usePluginTranslation,
  type StepMarker,
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

type Translate = ReturnType<typeof usePluginTranslation>;

function statusDetail(candidate: TriageFixPullRequestV1, text: Translate): string | undefined {
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
/** The fix's state as the step's marker, said in words: merged passed, open still running, closed without merging failed. */
function fixMarker(candidate: TriageFixPullRequestV1, text: Translate): StepMarker {
  switch (candidate.status) {
    case 'merged':
      return { kind: 'state', state: 'passed', label: text('plugins.triage.surface.detail.fixPr.merged', 'Merged') };
    case 'closed':
      return { kind: 'state', state: 'failed', label: text('plugins.triage.surface.detail.fixPr.closed', 'Closed without merging') };
    case 'open':
      return { kind: 'state', state: 'running', label: text('plugins.triage.surface.detail.fixPr.open', 'Open') };
    default:
      return { kind: 'state', state: 'running', label: text('plugins.triage.surface.detail.fixPr.title', 'Fix pull request') };
  }
}

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
    // A quiet line with its Retry, inside the story: the rest of the entry is still readable.
    return (
      <Status
        tone="warning"
        labelKey="plugins.triage.surface.detail.fixPr.readFailed"
        label="Fix pull request links could not be read."
        action={<Button titleKey="plugins.triage.surface.actions.retry" title="Retry"
          accessibilityLabel={`${text('plugins.triage.surface.actions.retry', 'Retry')}: ${text('plugins.triage.surface.detail.fixPr.title', 'Fix pull request')}`}
          variant="plain" size="small" onPress={state.retry} />}
      />
    );
  }
  const linkedKeys = new Set(state.candidates.map((candidate) => refKey(candidate.entryRef)));
  const offers = props.pickable.filter((pick) => !linkedKeys.has(refKey(pick.entryRef)));
  const heading = text('plugins.triage.surface.detail.fixPr.title', 'Fix pull request');
  const linkLabel = text('plugins.triage.surface.detail.fixPr.link', 'Link fix PR');

  const lead = state.primary ?? state.candidates[0] ?? null;
  const titleOf = (candidate: TriageFixPullRequestV1) => candidate.display.title
    ?? candidate.display.displayPath
    ?? candidate.entryRef.entryId;
  const unlinkLabel = text('plugins.triage.surface.detail.fixPr.unlink', 'Unlink');
  const unlink = (candidate: TriageFixPullRequestV1) => (
    <Button
      title={unlinkLabel}
      accessibilityLabel={`${unlinkLabel} ${titleOf(candidate)}`}
      variant="plain"
      size="small"
      disabled={state.busy}
      onPress={() => state.unlink(candidate.entryRef)}
    />
  );
  const others = state.candidates.filter((candidate) => candidate !== lead);

  return (
    <Stack gap="small">
      {lead === null ? null : (
        // The fix is a step of the entry's story: named after the pull request, its state as the marker.
        <Step
          marker={fixMarker(lead, text)}
          title={titleOf(lead)}
          trailing={unlink(lead)}
          testID="triage-story-fix-pr"
        >
          {(() => {
            // Its state in words, then where it lives: the marker's glyph is never the only carrier of state.
            const line = [statusDetail(lead, text), lead.display.scopeLabel]
              .filter((part): part is string => part !== undefined && part.length > 0)
              .join(' · ');
            return line.length === 0 ? null : <Text variant="caption" tone="secondary" value={line} />;
          })()}
          {others.length === 0 ? null : (
            <ItemGroup accessibilityLabel={heading}>
              {others.map((candidate) => {
                const title = titleOf(candidate);
                const detail = statusDetail(candidate, text);
                return (
                  <Item
                    key={refKey(candidate.entryRef)}
                    title={title}
                    {...(candidate.display.scopeLabel === undefined ? {} : { subtitle: candidate.display.scopeLabel })}
                    {...(detail === undefined ? {} : { detail })}
                    accessibilityLabel={title}
                    accessoryOutsidePressable
                    accessory={unlink(candidate)}
                  />
                );
              })}
            </ItemGroup>
          )}
        </Step>
      )}
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
