import { describe, expect, it } from 'vitest';
import { bindVoiceSessionSpawnInput } from './bindSessionSpawnInput';

describe('Voice Session creation authoring ingress', () => {
  it('retains Project-selected Agent and placement omissions for canonical Action preparation', async () => {
    const input = { creationKey: 'voice-project-choice', directory: { kind: 'path', path: '/work/project' },
      projectContext: { projectRef: { serverId: 'home-a', projectKey: 'project-a' } },
      initialInput: { text: 'Inspect this project.' } };
    const result = await bindVoiceSessionSpawnInput(input);
    expect(result).toEqual({ ok: true, input });
  });
});
