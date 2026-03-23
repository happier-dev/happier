import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import {
  PromptBundleBodyV1Schema,
  PromptDocArtifactHeaderV1Schema,
  PromptDocBodyV1Schema,
  validatePromptBundleBodyV1AgainstSchemaId,
} from '@happier-dev/protocol';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import {
  createArtifactViaApi,
  decodeArtifactJsonBase64,
  fetchArtifactViaApi,
  listArtifactsViaApi,
} from '../../src/testkit/artifactApi';
import { FailureArtifacts } from '../../src/testkit/failureArtifacts';
import { envFlag } from '../../src/testkit/env';
import { writeTestManifestForServer } from '../../src/testkit/manifestForServer';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: prompts library artifact roundtrip', () => {
  let server: StartedServer | null = null;

  afterAll(async () => {
    await server?.stop().catch(() => {});
    server = null;
  }, 60_000);

  it('roundtrips prompt docs and skill bundles through the artifacts api', async () => {
    const testDir = run.testDir(`prompts-library-artifact-roundtrip-${randomUUID()}`);
    const saveArtifactsOnSuccess = envFlag(['HAPPIER_E2E_SAVE_ARTIFACTS', 'HAPPY_E2E_SAVE_ARTIFACTS'], false);
    const startedAt = new Date().toISOString();

    server = await startServerLight({ testDir });
    const auth = await createTestAuth(server.baseUrl);

    writeTestManifestForServer({
      testDir,
      server,
      startedAt,
      runId: run.runId,
      testName: 'prompts-library-artifact-roundtrip',
      env: {
        CI: process.env.CI,
        HAPPIER_E2E_SAVE_ARTIFACTS: process.env.HAPPIER_E2E_SAVE_ARTIFACTS ?? process.env.HAPPY_E2E_SAVE_ARTIFACTS,
      },
    });

    const now = Date.now();
    const docArtifactId = randomUUID();
    const bundleArtifactId = randomUUID();
    const docHeader = {
      v: 1 as const,
      kind: 'prompt_doc.v2' as const,
      title: 'Reviewer prompt',
      folderId: 'code-review',
      tags: ['review', 'quality'],
      origin: 'user' as const,
    };
    const docBody = {
      v: 1 as const,
      markdown: 'Review this change carefully.',
      createdAtMs: now,
      updatedAtMs: now,
    };
    const bundleHeader = {
      v: 1 as const,
      kind: 'prompt_bundle.v2' as const,
      title: 'Review skill',
      bundleSchemaId: 'skills.skill_md_v1' as const,
      origin: 'imported' as const,
    };
    const bundleBody = {
      v: 1 as const,
      entries: [
        {
          path: 'SKILL.md',
          contentBase64: Buffer.from('---\nname: review-skill\n---\nUse checklists.', 'utf8').toString('base64'),
          contentKind: 'utf8' as const,
          unixMode: 0o644,
        },
        {
          path: 'notes/checklist.md',
          contentBase64: Buffer.from('- verify tests\n- verify docs', 'utf8').toString('base64'),
          contentKind: 'utf8' as const,
          unixMode: 0o644,
        },
      ],
      createdAtMs: now,
      updatedAtMs: now,
    };

    const artifacts = new FailureArtifacts();
    artifacts.json('prompt-doc.header.json', () => docHeader);
    artifacts.json('prompt-doc.body.json', () => docBody);
    artifacts.json('prompt-bundle.header.json', () => bundleHeader);
    artifacts.json('prompt-bundle.body.json', () => bundleBody);

    let passed = false;
    try {
      const createdDoc = await createArtifactViaApi({
        baseUrl: server.baseUrl,
        token: auth.token,
        artifactId: docArtifactId,
        headerJson: docHeader,
        bodyJson: docBody,
      });
      const createdBundle = await createArtifactViaApi({
        baseUrl: server.baseUrl,
        token: auth.token,
        artifactId: bundleArtifactId,
        headerJson: bundleHeader,
        bodyJson: bundleBody,
      });

      expect(createdDoc.headerVersion).toBe(1);
      expect(createdDoc.bodyVersion).toBe(1);
      expect(createdBundle.headerVersion).toBe(1);
      expect(createdBundle.bodyVersion).toBe(1);

      const list = await listArtifactsViaApi({ baseUrl: server.baseUrl, token: auth.token });
      artifacts.json('artifacts.list.json', () => list);

      const listedDoc = list.find((item) => item.id === docArtifactId);
      const listedBundle = list.find((item) => item.id === bundleArtifactId);
      expect(listedDoc).toBeTruthy();
      expect(listedBundle).toBeTruthy();

      const listedDocHeader = PromptDocArtifactHeaderV1Schema.parse(
        decodeArtifactJsonBase64<unknown>(listedDoc!.header),
      );
      expect(listedDocHeader.kind).toBe('prompt_doc.v2');
      expect(listedDocHeader.title).toBe('Reviewer prompt');

      const fetchedDoc = await fetchArtifactViaApi({
        baseUrl: server.baseUrl,
        token: auth.token,
        artifactId: docArtifactId,
      });
      const fetchedBundle = await fetchArtifactViaApi({
        baseUrl: server.baseUrl,
        token: auth.token,
        artifactId: bundleArtifactId,
      });
      artifacts.json('prompt-doc.fetched.json', () => fetchedDoc);
      artifacts.json('prompt-bundle.fetched.json', () => fetchedBundle);

      const parsedDocHeader = PromptDocArtifactHeaderV1Schema.parse(
        decodeArtifactJsonBase64<unknown>(fetchedDoc.header),
      );
      const parsedDocBody = PromptDocBodyV1Schema.parse(
        decodeArtifactJsonBase64<unknown>(fetchedDoc.body),
      );
      const parsedBundleBody = PromptBundleBodyV1Schema.parse(
        decodeArtifactJsonBase64<unknown>(fetchedBundle.body),
      );

      expect(parsedDocHeader.folderId).toBe('code-review');
      expect(parsedDocBody.markdown).toContain('Review this change carefully.');
      expect(parsedBundleBody.entries).toHaveLength(2);
      expect(
        validatePromptBundleBodyV1AgainstSchemaId({
          bundleSchemaId: 'skills.skill_md_v1',
          body: parsedBundleBody,
        }),
      ).toEqual({ ok: true });

      passed = true;
    } finally {
      await artifacts.dumpAll(testDir, { onlyIf: saveArtifactsOnSuccess || !passed });
    }
  }, 240_000);
});
