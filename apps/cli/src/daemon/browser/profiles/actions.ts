import type { PublicActionInputById, PublicActionResultById } from '@happier-dev/protocol/actions/actionSpecs';
import type { BROWSER_PROFILE_ACTION_IDS } from '@happier-dev/protocol/actions/actionIds';
import type { BrowserProfileStore } from './store';
import { BrowserOpenViewCommandV1Schema } from '@happier-dev/protocol/browser/control/v1';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import type { BrowserDaemonControlRoutes } from '../control/routes';
import { browserCommandDispatchFailure } from '../control/types';

type ProfileAction = typeof BROWSER_PROFILE_ACTION_IDS[number];
type ProfileRequest = PublicActionInputById[ProfileAction];
type ProfileResult = PublicActionResultById[ProfileAction];

/** Saved-profile Actions delegate persistence and running-browser cleanup to the existing store. */
export async function executeBrowserProfileAction(
  store: BrowserProfileStore,
  actionId: ProfileAction,
  request: ProfileRequest,
  control: BrowserDaemonControlRoutes,
  context: ActionExecutorContext,
): Promise<ProfileResult> {
  if (actionId === 'browser.profile.list') return { status: 'ready', profiles: [...await store.listPersistentProfiles()] };
  if (!('profileId' in request)) throw new TypeError('Profile mutation requires its catalog-validated identity.');
  const existing = store.getProfile(request.profileId) ?? await store.loadPersistentProfile(request.profileId);
  if (actionId === 'browser.profile.create') {
    if (existing) return { status: 'unavailable', code: 'profile_exists' };
    const profile = await store.registerPersistentProfile({
      profileId: request.profileId, storageMode: 'user', owner: { kind: 'user', id: request.profileId },
      ...('displayName' in request && request.displayName ? { displayName: request.displayName } : {}),
    });
    return { status: 'created', profile };
  }
  if (!existing || (existing.storageMode !== 'user' && existing.storageMode !== 'plugin')) {
    return { status: 'unavailable', code: 'profile_not_found' };
  }
  if (existing.lifecycleState !== 'active') return { status: 'unavailable', code: 'profile_unavailable' };
  if (actionId === 'browser.profile.select') {
    // The catalog validates the chosen saved identity and target before any existing tabs close.
    const { machineId: _machineId, ...openInput } = request as PublicActionInputById['browser.profile.select'];
    let open = BrowserOpenViewCommandV1Schema.parse(openInput);
    if (open.engineOverride === 'embedded') return browserCommandDispatchFailure({ commandId: open.commandId,
      code: 'unsupported_command', message: 'Saved profiles require managed Chromium.' });
    const views = control.listViews(open.browserSessionId, context);
    if (open.target.kind === 'streamedBrowser') {
      // Discovery's stream target is presentation; the daemon retains the page's semantic target.
      const binding = open.target.daemonView;
      const currentView = views.find(view => view.viewId === open.viewId && view.sourceId === open.target.targetId);
      if (!currentView || !binding || binding.browserSessionId !== open.browserSessionId || binding.viewId !== open.viewId) {
        return browserCommandDispatchFailure({ commandId: open.commandId, code: 'view_not_found',
          message: 'The Browser page is no longer available.' });
      }
      open = { ...open, target: currentView.target };
    }
    return control.replaceProfile(open, context);
  }
  const result = await store.purgeForExplicitRequest({ profileIds: [request.profileId] });
  return result.purgedProfileIds.includes(request.profileId)
    ? { status: 'deleted', profileId: request.profileId }
    : { status: 'unavailable', code: 'profile_purge_failed' };
}
