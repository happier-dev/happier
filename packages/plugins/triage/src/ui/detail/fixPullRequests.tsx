import * as React from 'react';

import {
  Action,
  Button,
  Icon,
  Item,
  ItemGroup,
  Menu,
  Row,
  Stack,
  Status,
  Step,
  Text,
  WidgetFrame,
  usePluginTranslation,
  type StepMarker,
} from '@happier-dev/plugin-ui';
import { TRIAGE_SET_FIX_PULL_REQUEST_ACTION_LOCAL_ID_V1, resolveTriageRowFactStatusToneV1, type TriageEntryRefV1, type TriageRowFactValueV1 } from '@happier-dev/triage-protocol/v1';

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
/** The fix's state as the step's marker, said in words: merged passed, open a hollow mark, closed without merging failed. */
function fixMarker(candidate: TriageFixPullRequestV1, text: Translate): StepMarker {
  switch (candidate.status) {
    case 'merged':
      return { kind: 'state', state: 'passed', label: text('plugins.triage.surface.detail.fixPr.merged', 'Merged') };
    case 'closed':
      return { kind: 'state', state: 'failed', label: text('plugins.triage.surface.detail.fixPr.closed', 'Closed without merging') };
    // An open pull request waits on review and merge; nothing here is running, so it never draws a spinner.
    case 'open':
      return { kind: 'state', state: 'open', label: text('plugins.triage.surface.detail.fixPr.open', 'Open') };
    default:
      return { kind: 'state', state: 'open', label: text('plugins.triage.surface.detail.fixPr.title', 'Fix pull request') };
  }
}

/** "Fix #2512" when the source's address carries the number; the generic name when it does not. */
function fixHeading(candidate: TriageFixPullRequestV1, text: Translate): string {
  const number = candidate.display.displayPath?.match(/#\d+$/u)?.[0];
  return number === undefined
    ? text('plugins.triage.surface.detail.fixPr.title', 'Fix pull request')
    : text('plugins.triage.surface.detail.fixPr.numbered', 'Fix {number}', { number });
}

export function TriageFixPullRequests(props: Readonly<{
  state: TriageFixPullRequestsStateV1;
  pickable: readonly TriageFixPullRequestPickV1[];
  /** The fix's place when it is a chapter of its own (an issue: report, fix, agent work); otherwise a hollow mark. */
  chapter?: number;
  /** Opens the primary fix pull request in place, when its read is admitted. */
  onOpenPrimary?: () => void;
  onRetry?: () => void;
  /** The fix's checks in its source's words; nothing is inferred here. */
  checksSummary?: TriageRowFactValueV1;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [leadMenuOpen, setLeadMenuOpen] = React.useState(false);
  const { state } = props;
  const heading = text('plugins.triage.surface.detail.fixPr.title', 'Fix pull request');
  // The chapter holds its place through every state before a fix is known, so nothing after it shifts or renumbers.
  const unsettled: StepMarker = props.chapter === undefined
    ? { kind: 'state', state: 'open', label: heading }
    : { kind: 'number', value: props.chapter };
  if (state.kind === 'reading') {
    return (
      <Step marker={unsettled} title={heading} testID="triage-story-fix-pr">
        <Status
          tone="muted"
          pulsing
          labelKey="plugins.triage.surface.detail.fixPr.reading"
          label="Looking for a fix pull request…"
        />
      </Step>
    );
  }
  if (state.kind === 'unreachable') {
    // A quiet line with its Retry, inside the story: the rest of the entry is still readable.
    return (
      <Step marker={unsettled} title={heading} testID="triage-story-fix-pr">
        <Status
          tone="warning"
          labelKey="plugins.triage.surface.detail.fixPr.readFailed"
          label="Fix pull request links could not be read."
          action={<Button titleKey="plugins.triage.surface.actions.retry" title="Retry"
            accessibilityLabel={`${text('plugins.triage.surface.actions.retry', 'Retry')}: ${heading}`}
            variant="plain" size="small" onPress={props.onRetry ?? state.retry} />}
        />
      </Step>
    );
  }
  const linkedKeys = new Set(state.candidates.map((candidate) => refKey(candidate.entryRef)));
  const offers = props.pickable.filter((pick) => !linkedKeys.has(refKey(pick.entryRef)));
  const linkLabel = text('plugins.triage.surface.detail.fixPr.link', 'Link fix PR');

  const lead = state.primary ?? state.candidates[0] ?? null;
  const titleOf = (candidate: TriageFixPullRequestV1) => candidate.display.title
    ?? candidate.display.displayPath
    ?? candidate.entryRef.entryId;
  const unlinkLabel = text('plugins.triage.surface.detail.fixPr.unlink', 'Unlink');
  const unlink = (candidate: TriageFixPullRequestV1) => (
    <Action.Control
      action={TRIAGE_SET_FIX_PULL_REQUEST_ACTION_LOCAL_ID_V1}
      controller={state.unlinkControl(candidate.entryRef)}
      title={unlinkLabel}
      accessibilityLabel={`${unlinkLabel} ${titleOf(candidate)}`}
      variant="plain"
      disabled={state.busy}
    />
  );
  const moreLabel = (candidate: TriageFixPullRequestV1) => text('plugins.triage.surface.detail.fixPr.more', 'More for {title}',
    { title: titleOf(candidate) });
  const others = state.candidates.filter((candidate) => candidate !== lead);
  // Linking one more is a rare correction beside a fix that already stands: it joins Unlink behind the card's ⋯.
  const linkItemId = (offer: TriageFixPullRequestPickV1) => `link:${refKey(offer.entryRef)}`;
  const linkOffer = (offer: TriageFixPullRequestPickV1 | undefined) => {
    if (offer === undefined || state.busy) return;
    state.link({ entryRef: offer.entryRef, display: { title: offer.title, scopeLabel: offer.scopeLabel } });
  };
  const linkMenu = (
    <Menu
      open={menuOpen}
      onOpenChange={setMenuOpen}
      trigger={linkLabel}
      // A control, not words: it reads as pressable where no fix stands yet.
      triggerAppearance="control"
      triggerIcon="add"
      triggerAccessibilityLabel={linkLabel}
      // Two pull requests may share a title; the repository under each tells them apart.
      items={offers.map((offer) => ({ id: refKey(offer.entryRef), label: offer.title, subtitle: offer.scopeLabel }))}
      onSelect={(id) => linkOffer(offers.find((candidate) => refKey(candidate.entryRef) === id))}
    />
  );

  return (
    <Stack gap="small">
      {lead === null ? (
        // No fix yet: the chapter still stands, naming what belongs here and offering the link when there is one to make.
        <Step marker={unsettled} title={heading} testID="triage-story-fix-pr">
          <Stack gap="small" align="flex-start">
            <Text
              variant="meta"
              tone="secondary"
              value={text('plugins.triage.surface.detail.fixPr.none', 'No pull request is linked as the fix yet.')}
            />
            {offers.length === 0 ? null : linkMenu}
          </Stack>
        </Step>
      ) : (
        // The fix is a step of the entry's story: its number names it, its state is the marker, its card says the rest.
        <Step marker={fixMarker(lead, text)} title={fixHeading(lead, text)} testID="triage-story-fix-pr"
          {...(props.checksSummary?.kind !== 'status' || lead !== state.primary ? {} : {
            trailing: <Text variant="micro" tone={resolveTriageRowFactStatusToneV1(props.checksSummary.tone)} value={props.checksSummary.value} />,
          })}>
          <Stack gap="small">
            <WidgetFrame
              frameStyle="card"
              placement="companion"
              anatomy="row"
              mark={<Icon name="change-open" size="small" tone="secondary" />}
              title={titleOf(lead)}
              accessibilityLabel={titleOf(lead)}
              {...(() => {
                // Its state in words, then where it lives: the marker's glyph is never the only carrier of state.
                const line = [statusDetail(lead, text), lead.display.scopeLabel]
                  .filter((part): part is string => part !== undefined && part.length > 0)
                  .join(' · ');
                return line.length === 0 ? {} : { source: line };
              })()}
              accessory={(
                <Row gap="xsmall" align="center">
                  {props.onOpenPrimary === undefined || lead !== state.primary ? null : (
                    <Button titleKey="plugins.triage.surface.detail.fixPr.openPullRequest" title="Open pull request"
                      variant="secondary" size="small" onPress={props.onOpenPrimary} />
                  )}
                  {/* Unlinking is a rare correction: behind ⋯, so the card offers one press (lab c8). */}
                  <Menu
                    open={leadMenuOpen}
                    onOpenChange={setLeadMenuOpen}
                    trigger={moreLabel(lead)}
                    triggerAccessibilityLabel={moreLabel(lead)}
                    triggerIcon="more"
                    items={[{ id: 'unlink', label: unlinkLabel, disabled: state.busy }]}
                    {...(offers.length === 0 ? {} : {
                      groups: [{
                        id: 'link',
                        accessibilityLabel: linkLabel,
                        items: offers.map((offer) => ({ id: linkItemId(offer), label: offer.title, ...(state.busy ? { disabled: true } : {}) })),
                      }],
                      showGroupLabels: true,
                    })}
                    onSelect={(id) => {
                      if (id === 'unlink') { if (!state.busy) state.unlink(lead.entryRef); return; }
                      linkOffer(offers.find((offer) => linkItemId(offer) === id));
                    }}
                  />
                </Row>
              )}
            />
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
          </Stack>
        </Step>
      )}
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
