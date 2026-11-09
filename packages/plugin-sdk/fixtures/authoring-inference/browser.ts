import type { ActionsService, PluginActionInputById } from '@happier-dev/plugin-sdk/actions';

/** Browser controls use the same typed inputs as the host's UI controls. */
export async function browserControlAuthoringFixture(
  actions: Pick<ActionsService, 'execute'>,
  input: Readonly<{
    open: PluginActionInputById['browser.workspace.open'];
    navigate: PluginActionInputById['browser.navigate'];
    createProfile: PluginActionInputById['browser.profile.create'];
    selectProfile: PluginActionInputById['browser.profile.select'];
    deleteProfile: PluginActionInputById['browser.profile.delete'];
    download: PluginActionInputById['files.save'];
  }>,
) {
  await actions.execute('browser.workspace.open', { ...input.open, engineOverride: 'managed' });
  await actions.execute('browser.navigate', { ...input.navigate, navigationIntent: 'address' });
  await actions.execute('browser.profile.create', input.createProfile);
  await actions.execute('browser.profile.select', input.selectProfile);
  await actions.execute('browser.profile.delete', input.deleteProfile);
  await actions.execute('files.save', input.download);
}
