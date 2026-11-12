import type { PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { t } from '@/text';

type CheckInOverride =
  | Readonly<{ afterTurns: number | null }>
  | null
  | undefined;

/** The slice of `useDiscussionSettings` the Discussion menu reads; the hook stays the only writer. */
export type DiscussionCheckInMenuSettings = Readonly<{
  status: 'idle' | 'loading' | 'ready' | 'unavailable';
  override: CheckInOverride;
  saving: boolean;
  canManage: boolean;
  dontPause(): unknown;
  inherit(): unknown;
}>;

/**
 * "Keep agents going here" (C3 DISC-17; positive since F11): one checked menu row whose subtitle says what applies now —
 * the Account's own value, Never here, or this Discussion's own count. Choosing it again returns to the
 * Account value; a Discussion-specific count is replaced by Never.
 */
export function buildDiscussionCheckInMenuAction(
  input: Readonly<{
    settings: DiscussionCheckInMenuSettings;
    /** The Account's `coordinationAutonomousCheckIn.afterTurns`; null is Never pause. */
    accountAfterTurns: number | null;
  }>,
): PageHeaderMenuAction | null {
  const { settings } = input;
  if (!settings.canManage) return null;
  const ready = settings.status === 'ready';
  const override = ready ? settings.override : undefined;
  const never = ready && override?.afterTurns === null;
  const subtitle = !ready
    ? settings.status === 'unavailable'
      ? t('session.collaboration.discussion.controls.unavailable')
      : undefined
    : override == null
      ? input.accountAfterTurns === null
        ? t('session.collaboration.discussion.controls.inheritsNever')
        : t('session.collaboration.discussion.controls.inheritsTurns', {
            count: input.accountAfterTurns,
          })
      : override.afterTurns === null
        ? t('session.collaboration.discussion.controls.neverHere')
        : t('session.collaboration.discussion.controls.turnsHere', {
            count: override.afterTurns,
          });
  return {
    id: 'dont-pause',
    testID: 'session-discussion-dont-pause',
    title: t('session.collaboration.discussion.controls.keepGoing'),
    category: 'check-in',
    disabled: !ready || settings.saving,
    loading: settings.saving,
    ...(ready && !settings.saving ? { checked: never } : {}),
    ...(subtitle ? { subtitle } : {}),
    onSelect: () => {
      void (never ? settings.inherit() : settings.dontPause());
    },
  };
}
