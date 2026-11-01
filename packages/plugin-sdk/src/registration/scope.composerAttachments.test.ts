import { describe, expect, it } from 'vitest';

import { createPluginRegistrationScope } from './scope.js';

function createAttachmentScope(
    requiredFields: readonly (
        | 'prepareForSend'
        | 'resolveForDispatch'
        | 'resolveForDispatchV2'
        | 'afterMessageAccepted'
    )[],
) {
    return createPluginRegistrationScope({
        pluginId: 'acme.composer',
        target: { realm: 'daemon' },
        rights: [{
            family: 'composerAttachments',
            localId: 'issue',
            target: { realm: 'daemon' },
            requiredFields,
        }] as never,
    });
}

describe('composer attachment registration', () => {
    it('publishes the exact lifecycle callbacks declared by the attachment', () => {
        const scope = createAttachmentScope(['prepareForSend']);
        scope.api.composerAttachments.register('issue', {
            prepareForSend: async () => ({ attachments: [] }),
        });

        const [registration] = scope.commit();

        expect(registration?.family).toBe('composerAttachments');
        expect(registration?.value).toEqual({
            prepareForSend: expect.any(Function),
        });
    });

    it('publishes the execution-run-capable dispatch callback when declared', () => {
        const scope = createAttachmentScope(['resolveForDispatchV2']);
        scope.api.composerAttachments.register('issue', {
            resolveForDispatchV2: async () => ({ attachments: [] }),
        });

        const [registration] = scope.commit();

        expect(registration?.family).toBe('composerAttachments');
        expect(registration?.value).toEqual({
            resolveForDispatchV2: expect.any(Function),
        });
    });

    it('retains a class and accessor-backed callback on its author receiver', async () => {
        const owners = new WeakMap<object, string>();
        class StructuralAttachmentRuntime {
            get prepareForSend() {
                return this.prepareForSendImplementation;
            }

            prepareForSendImplementation() {
                return Promise.resolve({
                    attachments: [],
                    owner: owners.get(this),
                });
            }
        }
        const runtime = new StructuralAttachmentRuntime();
        owners.set(runtime, 'structural-attachment');
        const scope = createAttachmentScope(['prepareForSend']);
        scope.api.composerAttachments.register('issue', runtime as never);

        const [registration] = scope.commit();
        expect(registration?.family).toBe('composerAttachments');
        if (registration?.family !== 'composerAttachments') {
            throw new Error('Expected Composer attachment registration');
        }
        expect(registration.value).toBe(runtime);
        await expect(Reflect.apply(
            registration.value.prepareForSend!,
            registration.value,
            [],
        )).resolves.toMatchObject({ owner: 'structural-attachment' });
    });

});
