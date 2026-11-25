import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { storage } from '@/sync/domains/state/storageStore';
import { t } from '@/text';
import { keepHyphenatedNameTogether, readDisplayedMachineName } from '@/utils/sessions/machineDisplayNames';
import { requestOpenExternalUrl as openExternalUrl } from '@/utils/url/requestOpenExternalUrl';

/** The published page that explains requester Sessions on another person's Machine (plan 42 §8). */
const SHARED_MACHINES_HELP_URL =
  'https://docs.happier.dev/accounts/session-sharing';
export const openSharedMachinesHelp = () => {
  void openExternalUrl(SHARED_MACHINES_HELP_URL);
};

export type RequesterDisclosureModel = Readonly<{
  /** The Machine owner's display name; null when they have none, and the copy says "someone else's". */
  owner: string | null;
  machine: string;
  /** `scoped` only when the scoped sign-in route was proven; `full` is the documented fallback. */
  signIn: 'scoped' | 'full';
  retention?: 'run' | 'trigger';
  /** Safe names from the resolved launch purpose projection, never credentials or Account ids. */
  signInPurposes?: readonly string[];
}>;

/** "Runs on Alice's devbox", or "someone else's devbox" when the owner has no display name: the badge, card and notice. */
export function formatRequesterRunsOn(owner: string | null, machine: string): string {
  return owner ? t('machineRequester.runsOn', { owner, machine }) : t('machineRequester.runsOnSomeoneElses', { machine });
}

/** The one wording of "whose Machine, how the sign-in lands, who can see it", for the card and the notice. */
export function formatRequesterDisclosureCopy(
  model: RequesterDisclosureModel,
): Readonly<{ title: string; description: string }> {
  const signIn =
    model.signIn === 'scoped'
      ? t('machineRequester.scopedSignIn', { machine: model.machine })
      : t('machineRequester.fullSignIn', {
          machine: model.machine,
          ...(model.retention ? { retention: model.retention } : {}),
        });
  const visibility = model.owner
    ? t('machineRequester.osVisibility', { owner: model.owner, machine: model.machine })
    : t('machineRequester.osVisibilityUnnamed', { machine: model.machine });
  const purposes = model.signInPurposes?.length
    ? ` ${t('machineRequester.signInPurposes', { purposes: model.signInPurposes.join(', ') })}`
    : '';
  return {
    title: formatRequesterRunsOn(model.owner, model.machine),
    description: `${signIn} ${visibility}${purposes}`,
  };
}

/** Present the Account's claimed first-use notice. */
export function presentRequesterMachineNotice(
  params: Readonly<{
    serverId: string;
    serverIdentityId: string;
    machineId: string;
  }>,
): void {
  const machineKey = `${params.serverIdentityId}:${params.machineId}`;
  const key = `machine-requester-use:${machineKey}`;
  // A host name like "NLDW3-5-36-33" wraps around the name, never inside it.
  const record = resolveServerScopedMachine(storage.getState(), params.serverId, params.machineId);
  const machine = keepHyphenatedNameTogether(readDisplayedMachineName(record) ?? params.machineId);
  const owner = record?.access?.custodian.displayName?.trim() || null;
  // The glance, not the badge popover's full account: whose Machine (the badge's own "Runs on" words), then what
  // that means in two sentences. It is told when the Machine is first used, before any one Session runs.
  const title = formatRequesterRunsOn(owner, machine);
  publishPresentationNotice({
    key,
    severity: 'info',
    sticky: true,
    emphasis: title,
    // No action beside it: the text keeps the notice's full width; the Runs-on badge links the help page.
    message: `${title}\n${t('machineRequester.toldOnce')}`,
  });
}
