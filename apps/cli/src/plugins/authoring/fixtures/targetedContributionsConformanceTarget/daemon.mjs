const PROVIDER_POINT = Object.freeze({
  targetPluginId: 'acme.targeted-contributions-conformance-target',
  id: 'providers',
  protocol: Object.freeze({ id: 'packed-targeted-provider', version: 1 }),
});

export async function activate(api) {
  api.actions.register('verify-targeted-admission', async (_input, context) => {
    const observation = context.services.targetedContributions.observeForSelf(
      PROVIDER_POINT,
      { onInvalidated: () => {} },
    );
    try {
      const snapshot = await observation.readCurrent({ signal: context.signal });
      const unavailableGenericMethods = [];
      const reference = { pluginId: 'acme.targeted-contributions-conformance-contributor', localId: 'verify-provider' };
      for (const [method, invoke] of [
        ['execute', () => context.services.actions.execute(reference, {})],
        ['observe', () => context.services.actions.observe(reference, {}, () => {})],
        ['executeWithExecutionOrigin', () => context.services.actions.executeWithExecutionOrigin(reference, {})],
      ]) {
        try { await invoke(); }
        catch (error) {
          if (error?.code !== 'plugin_service_unavailable') throw error;
          unavailableGenericMethods.push(method);
        }
      }
      const verifications = [];
      for (const contribution of snapshot.contributions) {
        const result = await context.services.actions.executeAdmittedTargetedOperation(
          contribution.operations.verify,
          {},
          { signal: context.signal },
        );
        verifications.push(Object.freeze({
          contributor: Object.freeze({
            pluginId: contribution.contributor.pluginId,
            contributionId: contribution.contributor.contributionId,
            occurrenceId: contribution.contributor.occurrenceId,
          }),
          result,
        }));
      }
      return Object.freeze({
        targetOccurrenceId: snapshot.occurrenceId,
        contributors: Object.freeze(snapshot.contributions.map((contribution) => Object.freeze({
          pluginId: contribution.contributor.pluginId,
          contributionId: contribution.contributor.contributionId,
          occurrenceId: contribution.contributor.occurrenceId,
        }))),
        verifications: Object.freeze(verifications),
        unavailableGenericMethods: Object.freeze(unavailableGenericMethods),
      });
    } finally {
      observation.dispose();
    }
  });
}
