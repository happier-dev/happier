import type { EffectiveInputField  as EffectiveActionInputField} from '@happier-dev/protocol/inputs/inputFieldRuntime';
import { describe, expect, it } from 'vitest';

import { resolveExecutionRunLauncherOptionFields } from './ExecutionRunLauncherOptions';

const field = (path: string): EffectiveActionInputField => ({
    path,
    title: path,
    widget: path === 'permissionMode' ? 'select' : 'text',
    visible: true,
    required: false,
    disabled: false,
});

describe('resolveExecutionRunLauncherOptionFields', () => {
    it('retains the protocol permission control when an external Agent has no specialized permission metadata', () => {
        expect(resolveExecutionRunLauncherOptionFields({
            fields: [field('backendTargetKeys'), field('permissionMode'), field('modelId')],
            hasSpecializedPermissionOptions: false,
        }).map((entry) => entry.path)).toEqual(['permissionMode', 'modelId']);
    });

    it('uses the specialized permission control without rendering a duplicate protocol field', () => {
        expect(resolveExecutionRunLauncherOptionFields({
            fields: [
                field('permissionMode'),
                field('modelId'),
                field('teamCredentialModel'),
                field('teamCredentialSessionBindingConsent'),
                field('secretReferenceOverlay'),
            ],
            hasSpecializedPermissionOptions: true,
        }).map((entry) => entry.path)).toEqual(['modelId']);
    });
});
