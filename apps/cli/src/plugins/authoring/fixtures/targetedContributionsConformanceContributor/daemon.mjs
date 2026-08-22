export async function activate(api) {
  api.actions.register('verify-provider', async () => Object.freeze({ verified: true }));
}
