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
            immutableGenerationId: contribution.contributor.immutableGenerationId,
          }),
          result,
        }));
      }
      return Object.freeze({
        targetGeneration: snapshot.generation,
        contributors: Object.freeze(snapshot.contributions.map((contribution) => Object.freeze({
          pluginId: contribution.contributor.pluginId,
          contributionId: contribution.contributor.contributionId,
          immutableGenerationId: contribution.contributor.immutableGenerationId,
        }))),
        verifications: Object.freeze(verifications),
      });
    } finally {
      observation.dispose();
    }
  });
}
