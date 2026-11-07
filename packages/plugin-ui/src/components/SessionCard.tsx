import type { ReactElement, ReactNode } from 'react';

import {
  useSessionState,
  type SessionStateReadV1,
} from '../hostApi/sessionState.public.js';
import {
  HAPPIER_WORK_STATUS_SEMANTIC_TONE,
  type HappierWorkStatusTone,
} from '../presentation/work/workStatus.js';
import { IconButton } from './Button.js';
import { Icon } from './Icon.js';
import { BrandMark } from './Image.js';
import { usePluginTranslation } from './PluginUiProvider.js';
import { Status } from './Status.js';
import { WidgetFrame } from './WidgetFrame.js';

/** The state sentence a card shows: the host's own Work word by default, or the caller's sentence for it. */
export type SessionCardStatus = Readonly<{
  label: string;
  tone: HappierWorkStatusTone;
  /** The agent is working now: the status pulses (reduced motion keeps it still). */
  live?: boolean;
}>;

export type SessionCardProps = Readonly<{
  /** A Session in the mounting surface's Account. */
  sessionId: string;
  /**
   * A read of this Session the surface already follows (`useSessionState`), so a page that also shows the
   * Session elsewhere keeps one watch. Omitted, the card reads the Session itself.
   */
  read?: SessionStateReadV1;
  /** Your sentence for the Session's state. Omitted, the host's own word; `null` shows no status. */
  status?: SessionCardStatus | null;
  /** Opens the Session: the trailing arrow. */
  onOpen: () => void;
  openBusy?: boolean;
  openDisabled?: boolean;
  /** A press on the card itself (show this Session in place); without it only the arrow is pressable. */
  onPress?: () => void;
  /** A quiet line about this card under its identity: why it could not open, that another is opening. */
  notice?: ReactNode;
  /** What the agent did for your entry (findings, a note), under the card's identity. */
  children?: ReactNode;
  testID?: string;
}>;

/** Where a Session works, as a reader names it: its worktree, else its project. */
function readSessionWhere(read: SessionStateReadV1): string | undefined {
  return (
    read.state?.workspace?.worktreeName ?? read.state?.workspace?.projectName
  );
}

/**
 * A Session working on something your plugin shows: the agent's mark, the Session's name, where it works, its
 * state, and the arrow that opens it. Draw it wherever an entry, task or record names the agent working on it
 * (a detail, the end of an activity timeline, a widget) so every surface shows that Session the same way.
 *
 * The title is the host's: a Session that has not been read yet is not "untitled", and one this Account cannot
 * reach says so instead of inventing a name.
 *
 * ```tsx
 * <SessionCard sessionId={linked.sessionId} onOpen={() => openSession(linked.sessionId)} />
 * ```
 */
export function SessionCard(props: SessionCardProps): ReactElement {
  const translate = usePluginTranslation();
  const own = useSessionState(
    props.read === undefined ? props.sessionId : null,
  );
  const read = props.read ?? own;
  const state = read.state;
  const title =
    state !== null
      ? state.title?.trim() ||
        translate('happier.plugin-ui.sessionCard.untitled', 'Untitled session')
      : read.status === 'loading'
        ? translate('happier.plugin-ui.sessionCard.reading', 'Loading…')
        : translate(
            'happier.plugin-ui.sessionCard.unavailable',
            'Session not found',
          );
  const where = readSessionWhere(read);
  const status: SessionCardStatus | null =
    props.status !== undefined
      ? props.status
      : state === null
        ? null
        : {
            label: state.workStatus.word,
            tone: state.workStatus.tone,
            live: state.workStatus.bucket === 'working',
          };
  const brand = state?.agent?.brand;
  const openLabel = `${translate('happier.plugin-ui.action.open', 'Open')} ${title}`;
  return (
    <WidgetFrame
      frameStyle="card"
      placement="companion"
      anatomy="row"
      {...(props.testID === undefined ? {} : { testID: props.testID })}
      {...(brand === undefined
        ? {}
        : {
            mark: (
              <BrandMark
                pluginId={brand.pluginId}
                size="small"
                externallyLabelled
              />
            ),
          })}
      title={title}
      accessibilityLabel={title}
      {...(props.onPress === undefined ? {} : { onOpen: props.onPress })}
      {...(props.notice === undefined || props.notice === null ? {} : { facts: props.notice })}
      {...(where === undefined ? {} : { source: where })}
      {...(status === null
        ? {}
        : {
            meta: (
              <Status
                tone={HAPPIER_WORK_STATUS_SEMANTIC_TONE[status.tone]}
                label={status.label}
                pulsing={status.live === true}
              />
            ),
          })}
      accessory={
        <IconButton
          icon={<Icon name="external" tone="secondary" />}
          accessibilityLabel={openLabel}
          busy={props.openBusy === true}
          disabled={props.openDisabled === true}
          onPress={props.onOpen}
        />
      }
    >
      {props.children}
    </WidgetFrame>
  );
}
