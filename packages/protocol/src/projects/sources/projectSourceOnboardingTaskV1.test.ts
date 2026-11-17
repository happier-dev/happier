import { describe, expect, it } from 'vitest';
import { readPromptDocInLibrary } from '../../prompts/library/promptLibraryActionOperations.js';
import type { PromptDocArtifactRefV1 } from '../../prompts/library/promptArtifactRefsV1.js';
import type { ProjectSourceV1 } from './projectSourceV1.js';
import { projectSourceOnboardingTaskReferenceV1, resolveProjectSourceOnboardingTaskV1 } from './projectSourceOnboardingTaskV1.js';

const source = (id: string, task?: string): Readonly<{ serverId: string; source: ProjectSourceV1 }> => ({ serverId: 'home', source: {
  id, name: id, revision: 1, audience: [], createdByAccountId: 'author',
  attachments: task ? [{ purpose: 'onboarding_task', ref: { kind: 'doc', artifactId: task } }] : [],
} });

describe('Source first-task selection', () => {
  it('projects an authoring reference without loading content or replacing an explicit Home', () => {
    const selected = source('project', 'task');
    expect(projectSourceOnboardingTaskReferenceV1(selected)).toEqual({ serverId: 'home', sourceId: 'project', sourceName: 'project',
      ref: { kind: 'doc', artifactId: 'task', serverId: 'home' } });
    selected.source.attachments = [{ purpose: 'onboarding_task', ref: { kind: 'doc', artifactId: 'task', serverId: 'other-home' } }];
    expect(projectSourceOnboardingTaskReferenceV1(selected)?.ref.serverId).toBe('other-home');
    expect(projectSourceOnboardingTaskReferenceV1(source('empty'))).toBeNull();
  });
  it('reads only tagged tasks in displayed Source order and retains the prompt owner refusal before using an available task', async () => {
    const reads: PromptDocArtifactRefV1[] = [];
    const selection = await resolveProjectSourceOnboardingTaskV1({ sources: [source('first', 'private'), source('second', 'available'), source('third', 'unused')],
      readPrompt: async (ref, options) => readPromptDocInLibrary({ artifactId: ref.artifactId, signal: options?.signal,
        store: { read: async () => {
          reads.push(ref);
          return ref.artifactId === 'private' ? null : { id: ref.artifactId, revision: { headerVersion: 1, bodyVersion: 1 },
            header: { v: 1, kind: 'prompt_doc.v2', title: 'Review' },
            body: JSON.stringify({ v: 1, markdown: 'Inspect the project', createdAtMs: 1, updatedAtMs: 1 }) };
        } },
      }),
    });
    expect(selection.task).toMatchObject({ sourceId: 'second', sourceName: 'second', markdown: 'Inspect the project', title: 'Review' });
    expect(selection.unavailable).toMatchObject([{ sourceId: 'first', result: { ok: false, errorCode: 'prompt_doc_not_found' } }]);
    expect(reads.map(ref => [ref.serverId, ref.artifactId])).toEqual([['home', 'private'], ['home', 'available']]);
  });

  it('does no prompt read for context attachments or Sources without a suggested task', async () => {
    const contextual = source('context');
    contextual.source.attachments = [{ purpose: 'context', entry: { id: 'background', enabled: true, placement: 'system_append',
      ref: { kind: 'doc', artifactId: 'not-a-task' } } }];
    let reads = 0;
    expect(await resolveProjectSourceOnboardingTaskV1({ sources: [contextual, source('empty')], readPrompt: ref => readPromptDocInLibrary({
      artifactId: ref.artifactId, store: { read: async () => { reads++; return null; } },
    }) })).toEqual({ task: null, unavailable: [] });
    expect(reads).toBe(0);
  });

  it('propagates cancellation without trying the next Source', async () => {
    const controller = new AbortController();
    let reads = 0;
    const selection = resolveProjectSourceOnboardingTaskV1({ sources: [source('first', 'one'), source('second', 'two')], signal: controller.signal,
      readPrompt: (ref, options) => readPromptDocInLibrary({ artifactId: ref.artifactId, signal: options?.signal,
        store: { read: async () => { reads++; controller.abort(); return null; } } }),
    });
    await expect(selection).rejects.toMatchObject({ name: 'AbortError' });
    expect(reads).toBe(1);
  });
});
