import { expect, it } from 'vitest';
import { readReadOnlySkillContentV1 } from '../promptBundleSchemas.js';
import { decodeBase64 } from '../../../crypto/base64.js';

it('opens the bundled deploy skill and its on-demand create-app reference through the skill reader', () => {
    const skill = readReadOnlySkillContentV1('happier:deploy')!;
    const reference = skill.body.entries.find(entry => entry.path === 'references/create-app.md');
    expect(reference?.contentKind).toBe('utf8');
    expect(skill.skillMd).toContain('references/create-app.md');
    const content = new TextDecoder().decode(decodeBase64(reference!.contentBase64, 'base64'));
    expect(content).toContain('projects.script.run');
    expect(content).toContain('deployments.health.current');
    expect(content).toContain('deployments.suggestions.check');
});
