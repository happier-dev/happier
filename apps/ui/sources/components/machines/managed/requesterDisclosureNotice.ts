import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { claimRequesterMachineNotice } from '@/sync/domains/state/disclosureUiState';
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

/**
 * Owner ruling 2026-11-23 "tell once, never block": the first time this device sends the person's
 * sign-in to a Machine another person holds, say so once. Never awaited and never refuses: the
 * Action has already been admitted and proceeds whatever happens here.
 */
export function tellRequesterMachineUseOnce(
  params: Readonly<{
    serverId: string;
    serverIdentityId: string;
    machineId: string;
    owner: Readonly<{ displayName?: string | null }>;
  }>,
): void {
  const machineKey = `${params.serverIdentityId}:${params.machineId}`;
  const key = `machine-requester-use:${machineKey}`;
  try {
    if (!claimRequesterMachineNotice(machineKey)) return;
  } catch {
    // Device storage refused the record: tell now; it may be told again on a later use.
  }
  // A host name like "NLDW3-5-36-33" wraps around the name, never inside it.
  const machine = keepHyphenatedNameTogether(
    readDisplayedMachineName(
      resolveServerScopedMachine(
        storage.getState(),
        params.serverId,
        params.machineId,
      ),
    ) ?? params.machineId,
  );
  // The glance, not the badge popover's full account: whose Machine (the badge's own "Runs on" words), then what
  // that means in two sentences. It is told when the Machine is first used, before any one Session runs.
  const title = formatRequesterRunsOn(params.owner.displayName || null, machine);
  publishPresentationNotice({
    key,
    severity: 'info',
    sticky: true,
    emphasis: title,
    // No action beside it: the text keeps the notice's full width; the Runs-on badge links the help page.
    message: `${title}\n${t('machineRequester.toldOnce')}`,
  });
}
