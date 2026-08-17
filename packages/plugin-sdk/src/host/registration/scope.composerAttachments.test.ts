import { describe, expect, it } from 'vitest';

import { createPluginRegistrationScope } from './index.js';

function createAttachmentScope(
    requiredFields: readonly ('prepareForSend' | 'resolveForDispatch' | 'afterMessageAccepted')[],
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

    it('captures a class and accessor-backed declared callback with its author receiver', async () => {
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
        expect(Object.isFrozen(registration.value)).toBe(true);
        await expect(Reflect.apply(
            registration.value.prepareForSend!,
            {},
            [],
        )).resolves.toMatchObject({ owner: 'structural-attachment' });
    });

    it('rejects an undeclared or unknown attachment runtime callback', () => {
        const withUndeclaredCallback = createAttachmentScope(['prepareForSend']);
        withUndeclaredCallback.api.composerAttachments.register('issue', {
            prepareForSend: async () => ({ attachments: [] }),
            resolveForDispatch: async () => ({ attachments: [] }),
        } as never);
        expect(() => withUndeclaredCallback.commit())
            .toThrow(/runtime callbacks do not match its declaration/i);

        const withUnknownProperty = createAttachmentScope(['prepareForSend']);
        withUnknownProperty.api.composerAttachments.register('issue', {
            prepareForSend: async () => ({ attachments: [] }),
            unexpected: true,
        } as never);
        expect(() => withUnknownProperty.commit())
            .toThrow(/invalid 'composerAttachments\/issue' runtime/i);
    });
});
