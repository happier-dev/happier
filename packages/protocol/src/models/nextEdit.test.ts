import { describe, expect, it } from 'vitest';
import { ProviderModelDescriptorV1Schema, projectProviderModelGenerationSettings } from './descriptor.js';

describe('dedicated next-edit model facts', () => {
  it('preserves the model operation and projects the public output allowance at its existing owner', () => {
    const model = { id: 'edit-model', name: 'Edit model', contextWindowTokens: 4096,
      nextEdit: { operationId: 'edit', tokenAccounting: 'utf8-bytes', promptOverheadTokens: 32, maxOutputTokens: 1024 } };
    expect(ProviderModelDescriptorV1Schema.safeParse(model).success).toBe(true);
    const parsed = ProviderModelDescriptorV1Schema.parse(model);
    expect(projectProviderModelGenerationSettings(parsed, { maxTokens: 512 })).toMatchObject({ nextEdit: { outputTokens: 512 } });
    expect(projectProviderModelGenerationSettings(parsed, { maxTokens: 0 })).not.toHaveProperty('nextEdit', expect.anything());
  });
});
