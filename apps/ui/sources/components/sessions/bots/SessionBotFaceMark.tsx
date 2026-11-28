import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { areSessionBotFacesEqual, type SessionBotFaceV1 } from '@happier-dev/protocol/sessions/identity/sessionBotV1';

import { seedDiscussionDraft } from '@/components/discussions/useDiscussionDraft';
import { useOpenDiscussion } from '@/components/discussions/useOpenDiscussion';
import { useSessionConversationsAvailability } from '@/components/sessions/conversations/useSessionConversationsAvailability';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { sessionDisplayActions } from '@/sync/ops/sessions/sessionDisplayActions';
import { t } from '@/text';

import { applyBotFacePickerGesture, BotFacePicker, type BotFacePickerStatus } from './BotFacePicker';
import { useBotFaceWearRequest } from './botFaceWearIntent';
import type { BotFaceMood } from './face/botFaceGeometry';
import { SessionBotFace } from './face/SessionBotFace';
import type { SessionBotFaceFacts } from './face/sessionBotFaceFacts';

type Preview = Readonly<{ face: SessionBotFaceV1 | null }>;

/**
 * Edits an existing Bot's face: each picker gesture previews at once and saves once through
 * `session.bot.face.set` with the face shown, seed included. The preview stands until the saved face arrives; a
 * refused save reverts to the saved face and says so in the picker.
 */
export function useSessionBotFaceEditor(
  params: Readonly<{
    sessionId: string;
    serverId: string | null;
    facts: SessionBotFaceFacts;
  }>,
) {
  const { sessionId, serverId, facts } = params;
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [status, setStatus] = React.useState<BotFacePickerStatus>('idle');
  const gesture = React.useRef(0);
  // The saved face arriving replaces the preview; a face saved elsewhere meanwhile is a visible, recoverable glitch.
  React.useEffect(() => {
    setPreview((current) => (current && areSessionBotFacesEqual(current.face, facts.face) ? null : current));
  }, [facts.face]);
  const change = React.useCallback(
    (next: SessionBotFaceV1 | null) => {
      const current = ++gesture.current;
      setPreview({ face: next });
      setStatus('saving');
      void sessionDisplayActions
        .setBotFace(sessionId, next, { serverId })
        .then(
          (result) => result.ok,
          () => false,
        )
        .then((ok) => {
          if (current !== gesture.current) return;
          setStatus(ok ? 'idle' : 'failed');
          if (!ok) setPreview(null);
        });
    },
    [serverId, sessionId],
  );
  const shown = React.useMemo<SessionBotFaceFacts>(
    // A Bot's own seed is its Session id (`getSessionAvatarId`); a cleared preview falls back to it.
    () =>
      preview
        ? { seed: preview.face?.seed ?? sessionId, face: preview.face }
        : facts,
    [facts, preview, sessionId],
  );
  return { shown, status, change };
}

function BotFaceMenu(props: Readonly<{
  anchorRef: React.RefObject<View | null>;
  accountLifetime: ServerAccountScopeLifetime;
  sessionId: string;
  onOpenChange: (next: boolean) => void;
  onChangeFace: () => void;
}>) {
  const { accountLifetime, sessionId } = props;
  const scope = accountLifetime.scope;
  const prepareNewDraft = React.useCallback((draftId: string) => {
    seedDiscussionDraft({ scope, address: { kind: 'newDiscussion', draftId },
      text: '', mentions: [], participants: [{ kind: 'session', sessionId, answerPolicy: 'when_mentioned' }] });
  }, [scope, sessionId]);
  const { openNewDiscussion } = useOpenDiscussion({ address: scope,
    anchor: { kind: 'session', sessionId }, sourceSurface: 'collaboration', prepareNewDraft });
  return <DropdownMenu
    open
    popoverAnchorRef={props.anchorRef}
    onOpenChange={props.onOpenChange}
    items={[
      { id: 'change-face', title: t('bots.face.change') },
      { id: 'new-discussion', title: t('botTemplates.newGroup') },
    ]}
    matchTriggerWidth={false}
    onSelect={(id) => {
      if (id === 'change-face') props.onChangeFace();
      if (id === 'new-discussion' && accountLifetime.isCurrent()) openNewDiscussion();
    }}
  />;
}

/** The editable face in the Session header anchors the Bot's face chooser and group entry. */
export const SessionBotFaceMark = React.memo(function SessionBotFaceMark(
  props: Readonly<{
    sessionId: string;
    serverId: string | null;
    accountLifetime?: ServerAccountScopeLifetime | null;
    facts: SessionBotFaceFacts;
    size: number;
    mood?: BotFaceMood;
    /** The face's motion at this surface (`SessionBotFace`'s), e.g. the header's hover perk. */
    motion?: React.ComponentProps<typeof SessionBotFace>['motion'];
    testID?: string;
  }>,
) {
  const { theme } = useUnistyles();
  const anchorRef = React.useRef<View | null>(null);
  const [open, setOpen] = React.useState(false);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const editor = useSessionBotFaceEditor(props);
  const { accountLifetime, serverId, sessionId } = props;
  const conversationsAvailable = useSessionConversationsAvailability(serverId ?? '');
  const canStartDiscussion = conversationsAvailable && accountLifetime?.isCurrent() === true;
  // A pet handed over by "Use as a Bot's face…" (R12 §10): the chooser opens wearing it, and that is the one change.
  const shown = React.useRef(editor.shown);
  shown.current = editor.shown;
  useBotFaceWearRequest(props.sessionId, (pet) => {
    editor.change(applyBotFacePickerGesture(shown.current.face, shown.current.seed, { kind: 'pet', pet }));
    setOpen(true);
  });
  return (
    <View ref={anchorRef} collapsable={false}>
      <HappierPressable
        testID={props.testID ?? 'bot-face-mark'}
        accessibilityRole="button"
        accessibilityLabel={t(canStartDiscussion ? 'common.moreActions' : 'bots.face.change')}
        hasPopup={canStartDiscussion ? 'menu' : 'dialog'}
        expanded={menuOpen || open}
        onPress={() => canStartDiscussion ? setMenuOpen(true) : setOpen(true)}
        style={(state) => [
          { borderRadius: props.size / 2 },
          focusRingStyle({
            focused: state.focused,
            color: theme.colors.border.focus,
          }),
        ]}
      >
        <SessionBotFace
          facts={editor.shown}
          size={props.size}
          mood={props.mood}
          motion={props.motion}
        />
      </HappierPressable>
      {canStartDiscussion && menuOpen ? <BotFaceMenu
        anchorRef={anchorRef}
        accountLifetime={accountLifetime}
        sessionId={sessionId}
        onOpenChange={setMenuOpen}
        onChangeFace={() => setOpen(true)}
      /> : null}
      <BotFacePicker
        open={open}
        anchorRef={anchorRef}
        onRequestClose={() => setOpen(false)}
        seed={editor.shown.seed}
        face={editor.shown.face}
        onChange={editor.change}
        status={editor.status}
      />
    </View>
  );
});
