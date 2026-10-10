import { describe, expect, it } from 'vitest';
import { createLaunchProfilePublisherV1 } from './publishLaunchProfile.js';
import { ProfileRecordV1Schema } from '../profiles/profileRecordV1.js';
import { readLaunchProfileArtifactV1 } from './launchProfileArtifactV1.js';
import { readAiLaunchProfileRecords } from '../profiles/read.js';

describe('entity-row launch profile publication', () => {
  it('uses the row revision and preserves private stack and secret attachments', async () => {
    let record = ProfileRecordV1Schema.parse({ v: 1, id: 'work', definition: { kind: 'inline', profile: {
      v: 2, id: 'work', name: 'Work', createdAt: 1, updatedAt: 1, extraEnvironmentVariables: [],
      envVarRequirements: [{ name: 'DEPLOY_TOKEN', kind: 'secret', required: true }],
    } }, enabled: false,
      promptStack: [{ id: 'private-entry', ref: { kind: 'doc', artifactId: 'private-doc' }, enabled: true, placement: 'system_append' }],
      secretBindings: { DEPLOY_TOKEN: 'private-secret' } });
    let revision = 7;
    const artifacts = new Map<string, { artifactId: string; header: Readonly<Record<string, unknown>>; body: string }>();
    // The record transaction and Artifact transport are persistent system boundaries.
    const publisher = createLaunchProfilePublisherV1({ profileStore: {
      read: async () => ({ record, revision }),
      updateDefinition: async (input) => {
        if (input.expectedRevision !== revision) throw Object.assign(new Error('profile_publish_conflict'), { code: 'profile_publish_conflict' });
        record = { ...record, definition: { kind: 'artifact', artifactId: input.artifactId } };
        revision += 1;
      },
    }, artifactStore: { read: async (id) => artifacts.get(id) ?? null, create: async (input) => {
      const artifactId = 'published-row';
      artifacts.set(artifactId, { ...input, artifactId });
      return { artifactId };
    } } });
    const result = await publisher.publish({ profileId: 'work' });
    expect(record).toMatchObject({ id: 'work', enabled: false, definition: { kind: 'artifact', artifactId: result.artifactId },
      secretBindings: { DEPLOY_TOKEN: 'private-secret' }, promptStack: [{ ref: { artifactId: 'private-doc' } }] });
    const content = JSON.parse(artifacts.get(result.artifactId)!.body);
    expect(content.secretBindings).toEqual({});
    expect(content).not.toHaveProperty('promptStack');
    expect(content.profile.id).toBe('work');
    expect(await publisher.publish({ profileId: 'work' })).toEqual(result);
    expect(artifacts.size).toBe(1);
  });
  it('publishes an admitted retained inline identity at the same id and opens its resulting Artifact without new-authoring narrowing', async () => {
    // This is an admitted current entity row retaining predecessor identity after
    // conversion, not a claim that the predecessor authored V2 Artifacts.
    const id = ` retained-${'identity'.repeat(180)} `;
    const name = ` Retained ${'name'.repeat(20)} `;
    let record = ProfileRecordV1Schema.parse({ v: 1, id, definition: { kind: 'inline', profile: {
      v: 2, id, name, createdAt: 1, updatedAt: 2, extraEnvironmentVariables: [],
      envVarRequirements: [{ name: 'DEPLOY_TOKEN', kind: 'secret', required: true }],
    } }, enabled: false, secretBindings: { DEPLOY_TOKEN: 'private-secret' },
      promptStack: [{ id: 'private-entry', ref: { kind: 'doc', artifactId: 'private-doc' }, enabled: true, placement: 'system_append' }] });
    let revision = 7;
    const artifacts = new Map<string, { artifactId: string; header: Readonly<Record<string, unknown>>; body: string }>();
    const publisher = createLaunchProfilePublisherV1({ profileStore: {
      read: async requestedId => requestedId === record.id ? { record, revision } : null,
      updateDefinition: async input => {
        if (input.profileId !== record.id || input.expectedRevision !== revision) throw new Error('profile_publish_conflict');
        record = ProfileRecordV1Schema.parse({ ...record, definition: { kind: 'artifact', artifactId: input.artifactId } });
        revision += 1;
      },
    }, artifactStore: {
      read: async artifactId => artifacts.get(artifactId) ?? null,
      create: async input => {
        const artifactId = 'retained-published-row';
        artifacts.set(artifactId, { ...input, artifactId });
        return { artifactId };
      },
    } });
    const result = await publisher.publish({ profileId: id });
    const artifact = artifacts.get(result.artifactId);
    if (!artifact) throw new Error('published_artifact_missing');
    expect(readLaunchProfileArtifactV1(artifact)).toMatchObject({ profile: { id, name }, secretBindings: {} });
    const opened = readAiLaunchProfileRecords([record], { artifactsById: artifacts,
      recordRevisionsById: new Map([[id, revision]]) });
    expect(opened.diagnostics).toEqual([]);
    expect(opened.entries).toMatchObject([{ profile: { id, name, enabled: false,
      promptStack: record.promptStack, secretBindings: { DEPLOY_TOKEN: 'private-secret' } } }]);
    expect(await publisher.publish({ profileId: id })).toEqual(result);
    expect(artifacts.size).toBe(1);
  });
});
