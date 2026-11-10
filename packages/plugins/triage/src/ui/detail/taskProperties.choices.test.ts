import { describe, expect, it } from 'vitest';

import { projectTriageTaskPropertiesV1 } from './taskProperties.js';

const text = ((_key: string, fallback: string) => fallback) as Parameters<typeof projectTriageTaskPropertiesV1>[0]['text'];
const base = {
  fields: ['assigneeIds', 'labelIds'] as const,
  values: { assigneeIds: ['gone-user'], labelIds: ['bug'] },
  candidates: new Map(),
  commit: () => undefined,
  text,
};

describe('task properties with a source directory', () => {
  it('offers people and labels as searchable choices, keeping a current value the directory no longer lists', () => {
    const items = projectTriageTaskPropertiesV1({
      ...base,
      fieldChoices: {
        assigneeIds: [{ id: 'ada', label: 'ada' }],
        labelIds: [{ id: 'bug', label: 'bug' }, { id: 'docs', label: 'docs' }],
      },
    });
    const assignees = items.find(item => item.id === 'assigneeIds')!.editor!;
    expect(assignees).toMatchObject({ kind: 'choices', searchable: true, value: ['gone-user'] });
    expect(assignees.kind === 'choices' && assignees.choices).toEqual([
      { id: 'ada', label: 'ada', person: 'ada' },
      { id: 'gone-user', label: 'gone-user', person: 'gone-user' },
    ]);
    const labels = items.find(item => item.id === 'labelIds')!.editor!;
    expect(labels).toMatchObject({ kind: 'choices', searchable: true, chips: true });
    expect(labels.kind === 'choices' && labels.choices.map(choice => choice.id)).toEqual(['bug', 'docs']);
    expect(labels.kind === 'choices' && labels.choices.every(choice => choice.person === undefined)).toBe(true);
  });

  it('commits the whole chosen set for the one field changed', () => {
    const commits: unknown[] = [];
    const items = projectTriageTaskPropertiesV1({
      ...base, commit: (fields) => { commits.push(fields); },
      fieldChoices: { assigneeIds: [{ id: 'ada', label: 'ada' }] },
    });
    const editor = items.find(item => item.id === 'assigneeIds')!.editor!;
    if (editor.kind === 'choices') void editor.onCommit(['gone-user', 'ada']);
    expect(commits).toEqual([{ assigneeIds: ['gone-user', 'ada'] }]);
  });

  it('never offers typed assignees: without a directory the picker keeps the current people and says why it lists no others', () => {
    const items = projectTriageTaskPropertiesV1({ ...base, assigneeLabels: new Map([['gone-user', 'Grace Hopper']]) });
    const editor = items.find(item => item.id === 'assigneeIds')!.editor!;
    expect(editor).toMatchObject({ kind: 'choices', value: ['gone-user'], directory: { status: 'unavailable' } });
    expect(editor.kind === 'choices' && editor.choices).toEqual([{ id: 'gone-user', label: 'Grace Hopper', person: 'Grace Hopper' }]);
  });

  it('keeps typed names where the source offers no directory for that field', () => {
    const items = projectTriageTaskPropertiesV1({ ...base, fieldChoices: { assigneeIds: [{ id: 'ada', label: 'ada' }] } });
    expect(items.find(item => item.id === 'labelIds')!.editor!.kind).toBe('list');
  });
});
