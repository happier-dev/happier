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
  owner: string;
  machine: string;
  /** `scoped` only when the scoped sign-in route was proven; `full` is the documented fallback. */
  signIn: 'scoped' | 'full';
  retention?: 'run' | 'trigger';
  /** Safe names from the resolved launch purpose projection, never credentials or Account ids. */
  signInPurposes?: readonly string[];
}>;

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
  const visibility = t('machineRequester.osVisibility', {
    owner: model.owner,
    machine: model.machine,
  });
  const purposes = model.signInPurposes?.length
    ? ` ${t('machineRequester.signInPurposes', { purposes: model.signInPurposes.join(', ') })}`
    : '';
  return {
    title: t('machineRequester.runsOn', {
      owner: model.owner,
      machine: model.machine,
    }),
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
  const copy = formatRequesterDisclosureCopy({
    owner: params.owner.displayName || t('shareSheet.person'),
    machine,
    signIn: 'full',
  });
  publishPresentationNotice({
    key,
    severity: 'info',
    sticky: true,
    emphasis: copy.title,
    // No action beside it: the text keeps the notice's full width; the Runs-on badge links the help page.
    message: `${copy.title}\n${copy.description}`,
  });
}
