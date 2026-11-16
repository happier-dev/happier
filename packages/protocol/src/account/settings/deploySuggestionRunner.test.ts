import { it, expect } from 'vitest';
import { accountSettingsParse } from './accountSettings.js';
import { readBuiltInSettingDeclarationV1, buildBuiltInAccountSettingMutationV1 } from '../../actions/settings/settingsDeclarations.js';
it('retains the deploy task custom model choice and defaults to Auto', () => {
    expect(accountSettingsParse({}).deploySuggestionRunnerV1).toBeNull();
    const choice = { v: 1, modelSelection: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'custom-model' } };
    expect(accountSettingsParse({ deploySuggestionRunnerV1: choice }).deploySuggestionRunnerV1).toEqual(choice);
});
it('exposes a custom deploy runner through the existing portable Settings mutation', () => {
    const declaration = readBuiltInSettingDeclarationV1('deployments.suggestionAgent');
    expect(declaration).not.toBeNull();
    if (!declaration) throw new Error('Missing deploy runner declaration');
    const choice = { v: 1, modelSelection: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'custom-model' } };
    expect(buildBuiltInAccountSettingMutationV1(declaration, {}, choice)).toEqual({ deploySuggestionRunnerV1: choice });
    expect(buildBuiltInAccountSettingMutationV1(declaration, {}, { v: 1, mode: 'auto' })).toEqual({ deploySuggestionRunnerV1: { v: 1, mode: 'auto' } });
});
