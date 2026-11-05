import { describe, expect, it } from 'vitest';
import { BotTemplateArtifactV1Schema, BotTemplateContentV1Schema, BotTemplateReleaseV1Schema,
  projectBotTemplateArtifactHeaderV1, projectBotTemplateReleaseV1, readBotTemplateArtifactV1, readBotTemplateReleaseV1 } from './botTemplateV1.js';
import { withArtifactExcerptV1 } from '../../artifacts/artifactExcerptV1.js';
import { botTemplateArtifactSharingAdapterV1 } from './botTemplateArtifactSharingV1.js';
import { getArtifactKindPolicyV1, getArtifactUseTargetV1 } from '../../artifacts/artifactSharingV1.js';
import { artifactActionListSelectionV1 } from '../../artifacts/artifactListSelectionV1.js';

const content = () => BotTemplateContentV1Schema.parse({ v: 1,
  identity: { name: 'Garden', description: 'Reusable gardening advice', madeFromName: 'Garden Bot' },
  instructions: { markdown: 'Explain the tradeoffs.' }, memoryRules: [], skills: [],
  needs: { software: [], connectedAccounts: [], mcpServers: [] } });
const draft = () => BotTemplateArtifactV1Schema.parse({ v: 1, state: 'draft',
  sourceSessionRef: { serverId: 'home', sessionId: 'private-source' },
  releaseArtifactId: '8e60ee82-ac53-4f6f-b04c-ff7ef873b9c9', content: content(),
  candidates: { memoryRules: [
    { key: 'rule', text: 'Prefer native plants', selected: true, personal: false, sourceRef: 'private-memory' },
    { key: 'personal', text: 'PRIVATE_FACT', personal: true },
  ], skills: [] } });
const metadata = { version: '1.0.0', releasedAtMs: 100, changelog: 'First release' };

describe('Bot template release boundary', () => {
  it('admits retained draft art when publishing without changing the stored draft reader', () => {
    const source = draft();
    if (source.state !== 'draft') throw new Error('fixture must be a draft');
    const shape = { v: 1 as const, fill: ['M20 0 L100 0 L100 80 L20 80 Z'], mouth: [60, 46, 0.8] as [number, number, number] };
    source.content.identity.face = { shape };
    expect(BotTemplateArtifactV1Schema.parse(source)).toEqual(source);
    expect(projectBotTemplateReleaseV1(source, metadata).content.identity.face?.shape?.mouth).toEqual([45, 46, 0.8]);
    source.content.identity.face.shape = { ...shape, fill: ['M0 0 H90 V90 Z'] };
    expect(BotTemplateArtifactV1Schema.parse(source)).toEqual(source);
    expect(() => projectBotTemplateReleaseV1(source, metadata)).toThrow();
  });

  it('reads the ordinary Artifact writer receipt with its body-derived header excerpt', () => {
    const source = draft();
    if (source.state !== 'draft') throw new Error('fixture must be a draft');
    const face = { body: 'tall', shape: { v: 1,
      fill: ['M 8 82 L 8 18 L 28 30 Q 45 15 62 30 L 82 18 L 82 82 Z'],
      stroke: [['M 20 75 Q 45 88 70 75', 2]], cut: ['M 13 24 L 22 30 L 13 35 Z'],
      mouth: [45, 55, 0.8], origin: 'custom',
    } };
    source.content = BotTemplateContentV1Schema.parse({ ...source.content,
      identity: { ...source.content.identity, face } });
    const released = { v: 1 as const, state: 'released' as const, release: projectBotTemplateReleaseV1(source, metadata) };
    for (const artifact of [source, released]) {
      const body = JSON.stringify(artifact);
      const header = withArtifactExcerptV1(projectBotTemplateArtifactHeaderV1(artifact), body);
      expect(header.face).toEqual(face);
      expect(readBotTemplateArtifactV1({ header, body })).toEqual(artifact);
    }
  });
  it('allows selected template headers while ordinary browsing still excludes them', () => {
    expect(artifactActionListSelectionV1({ kinds: ['bot_template.v1'] }).kinds).toEqual(['bot_template.v1']);
    expect(artifactActionListSelectionV1({}).browserListed).toBe(true);
  });
  it('projects only selected reusable content and never source addresses or private candidates', () => {
    const input = draft();
    if (input.state !== 'draft') throw new Error('fixture must be a draft');
    const release = projectBotTemplateReleaseV1(input, metadata);
    expect(BotTemplateReleaseV1Schema.parse(release)).toEqual(release);
    expect(release.content.memoryRules).toEqual([{ key: 'rule', text: 'Prefer native plants' }]);
    expect(JSON.stringify(release)).not.toMatch(/PRIVATE_FACT|private-source|private-memory|releaseArtifactId|sourceSessionRef/);
    expect(input.candidates.memoryRules[1]?.selected).toBe(false);
  });

  it('keeps skill bundle binary companions and excludes private skills', () => {
    const input = draft();
    if (input.state !== 'draft') throw new Error('fixture must be a draft');
    const entries = [{ path: 'SKILL.md', contentKind: 'utf8' as const,
      contentBase64: Buffer.from('---\nname: garden\ndescription: Garden guide\n---\nGarden advice').toString('base64') },
    { path: 'seed.bin', contentKind: 'binary' as const, contentBase64: 'AAEC/w==' }];
    input.candidates.skills = [
      { key: 'shared', title: 'Garden', bundleSchemaId: 'skills.skill_md_v1', entries, selection: 'as_is' },
      { key: 'private', title: 'PRIVATE_SKILL', bundleSchemaId: 'skills.skill_md_v1', entries, selection: 'private' },
    ];
    const release = projectBotTemplateReleaseV1(input, metadata);
    expect(release.content.skills).toEqual([{ key: 'shared', title: 'Garden', bundleSchemaId: 'skills.skill_md_v1', entries }]);
    expect(JSON.stringify(release)).not.toContain('PRIVATE_SKILL');
  });

  it('admits only valid released content for sharing and keeps drafts out of generic inventory', () => {
    const input = draft();
    if (input.state !== 'draft') throw new Error('fixture must be a draft');
    const draftResource = { artifactId: 'draft', header: { v: 1, kind: 'bot_template.v1', state: 'draft',
      title: 'Garden', description: '' }, body: JSON.stringify(input) };
    expect(botTemplateArtifactSharingAdapterV1.canShare(draftResource)).toBe(false);
    const release = projectBotTemplateReleaseV1(input, metadata);
    const releasedResource = { artifactId: 'release', header: { v: 1, kind: 'bot_template.v1', state: 'released',
      title: 'Garden', description: '', version: '1.0.0', changelog: 'First release' },
    body: JSON.stringify({ v: 1, state: 'released', release }) };
    expect(readBotTemplateArtifactV1(releasedResource)?.state).toBe('released');
    expect(botTemplateArtifactSharingAdapterV1.canShare(releasedResource)).toBe(true);
    expect(getArtifactKindPolicyV1('bot_template.v1')).toMatchObject({ browserListed: false, publicLinkAllowed: false, peopleSharingAllowed: true });
    expect(getArtifactUseTargetV1(draftResource).canShare).toBe(false);
    expect(getArtifactUseTargetV1(releasedResource).canShare).toBe(true);
    expect(getArtifactUseTargetV1(draftResource, 'signed_in').publicLinkAllowed).toBe(false);
    expect(getArtifactUseTargetV1(releasedResource, 'signed_in').publicLinkAllowed).toBe(true);
    expect(getArtifactUseTargetV1(releasedResource).publicLinkAllowed).toBe(false);
  });

  it('rejects source bindings, invalid bundles, duplicate keys and future content instead of silently dropping them', () => {
    const current = content();
    expect(BotTemplateContentV1Schema.safeParse({ ...current, sourceSessionId: 'private' }).success).toBe(false);
    expect(BotTemplateContentV1Schema.safeParse({ ...current, memoryRules: [
      { key: 'same', text: 'one' }, { key: 'same', text: 'two' },
    ] }).success).toBe(false);
    expect(BotTemplateContentV1Schema.safeParse({ ...current, skills: [
      { key: 'bad', title: 'Bad', bundleSchemaId: 'skills.skill_md_v1', entries: [] },
    ] }).success).toBe(false);
    expect(() => readBotTemplateReleaseV1({ ...metadata, v: 2, content: current })).toThrowError('update_required');
    expect(() => readBotTemplateReleaseV1({ ...metadata, version: '1.0', v: 1, content: current })).toThrowError('invalid_request');
  });

  it('reports unsupported authored versions through the shared Artifact reader and refuses sharing', () => {
    const header = { v: 1, kind: 'bot_template.v1', state: 'draft', title: 'Garden', description: '' };
    for (const resource of [
      { header: { ...header, v: 2 }, body: JSON.stringify(draft()) },
      { header, body: JSON.stringify({ ...draft(), v: 2 }) },
      { header, body: JSON.stringify({ ...draft(), content: { ...content(), v: 2 } }) },
    ]) {
      expect(() => readBotTemplateArtifactV1(resource)).toThrowError('update_required');
      expect(botTemplateArtifactSharingAdapterV1.canShare({ artifactId: 'future', ...resource })).toBe(false);
    }
    expect(() => readBotTemplateReleaseV1({ ...metadata, v: 1, content: { ...content(), v: 2 } })).toThrowError('update_required');
  });
});
