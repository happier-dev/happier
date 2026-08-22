import {
    AgentProviderBindingMaterializationV1Schema,
    type AgentProviderBindingMaterializationV1,
} from '@happier-dev/protocol';

import {
    readCredentialRedactionValues,
} from '@/plugins/runtime/invocation/services/credentialRedactionValues';

function containsMarker(
    value: unknown,
    markers: readonly string[],
): boolean {
    if (typeof value === 'string') {
        return markers.some((marker) => value.includes(marker));
    }
    if (Array.isArray(value)) {
        return value.some((entry) => containsMarker(entry, markers));
    }
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value).some(([key, entry]) => (
        markers.some((marker) => key.includes(marker))
        || containsMarker(entry, markers)
    ));
}

/**
 * Captures the runner-owned credential behind exact adapter-declared marker slots.
 * The marker-only materialization may cross Agent and daemon boundaries; the
 * returned transformer is consumed only by runner-host child launch owners.
 */
export function createRunnerManagedProviderBindingLaunchEnvironmentTransformer(
    input: Readonly<{
        materialization: unknown;
        placeholder: string;
        credential: string;
        renderedPlaceholder: string;
        renderedCredential: string;
        isCurrent(): boolean;
    }>,
): Readonly<{
    materialization: AgentProviderBindingMaterializationV1;
    redactionValues: readonly string[];
    transform(environment: Readonly<Record<string, string>>):
        Readonly<Record<string, string>>;
}> {
    if (
        input.placeholder.length < 32
        || input.credential.length === 0
        || input.placeholder === input.credential
        || input.renderedPlaceholder.length === 0
        || input.renderedCredential.length === 0
        || input.renderedPlaceholder === input.renderedCredential
        || input.renderedPlaceholder === input.placeholder
        || input.renderedCredential === input.credential
    ) {
        throw new Error(
            'Managed Provider credential placeholder is invalid',
        );
    }
    const parsed = AgentProviderBindingMaterializationV1Schema.parse(
        input.materialization,
    );
    if (containsMarker(parsed, [
        input.credential,
        input.renderedCredential,
    ])) {
        throw new Error(
            'Managed Provider materialization already contains the runner credential',
        );
    }
    const markers = Object.freeze([
        input.placeholder,
        input.renderedPlaceholder,
    ]);
    if ((
        parsed.kind === 'engineConfig'
        && containsMarker(parsed.engineConfig, markers)
    ) || (
        parsed.kind === 'configFile'
        && containsMarker(parsed.files, markers)
    )) {
        throw new Error(
            'Managed Provider credential placeholder escaped host-owned environment',
        );
    }
    const credentialSlots = new Map<string, Readonly<{
        placeholder: string;
        credential: string;
    }>>();
    for (const entry of parsed.env) {
        if (containsMarker(entry.name, markers)) {
            throw new Error('Managed Provider placeholder escaped into an environment key');
        }
        if (entry.value === input.placeholder) {
            credentialSlots.set(entry.name, Object.freeze({
                placeholder: input.placeholder,
                credential: input.credential,
            }));
        } else if (entry.value === input.renderedPlaceholder) {
            credentialSlots.set(entry.name, Object.freeze({
                placeholder: input.renderedPlaceholder,
                credential: input.renderedCredential,
            }));
        } else if (containsMarker(entry.value, markers)) {
            throw new Error(
                'Managed Provider placeholder must occupy an exact environment slot',
            );
        }
    }
    if (credentialSlots.size < 1) {
        throw new Error('Managed Provider materialization has no credential placeholder');
    }
    const retainedRedactionValues: string[] = [];
    for (const value of parsed.additionalRedactionValues ?? []) {
        if (
            value === input.placeholder
            || value === input.renderedPlaceholder
        ) continue;
        if (containsMarker(value, markers)) {
            throw new Error(
                'Managed Provider placeholder escaped through redaction data',
            );
        }
        retainedRedactionValues.push(value);
    }
    const materialization = AgentProviderBindingMaterializationV1Schema.parse({
        ...parsed,
        ...(retainedRedactionValues.length > 0
            ? { additionalRedactionValues: retainedRedactionValues }
            : { additionalRedactionValues: undefined }),
    });
    const readsCurrent = (): boolean => {
        try {
            return input.isCurrent();
        } catch {
            return false;
        }
    };
    return Object.freeze({
        materialization,
        redactionValues: readCredentialRedactionValues({
            rawCredential: input.credential,
            authorizationValue: input.renderedCredential,
        }),
        transform(environment) {
            if (!readsCurrent()) {
                throw new Error(
                    'Managed Provider launch credential authority is not current',
                );
            }
            if (containsMarker(environment, [
                input.credential,
                input.renderedCredential,
            ])) {
                throw new Error(
                    'Agent launch environment already contains the runner credential',
                );
            }
            const presentCredentialSlots = [...credentialSlots.keys()]
                .filter((name) => Object.hasOwn(environment, name));
            if (presentCredentialSlots.length === 0) {
                if (containsMarker(environment, markers)) {
                    throw new Error(
                        'Managed Provider placeholder escaped an owned launch environment slot',
                    );
                }
                return Object.freeze({ ...environment });
            }
            if (presentCredentialSlots.length !== credentialSlots.size) {
                throw new Error(
                    'Agent child launch environment is missing a managed Provider credential slot',
                );
            }
            const transformed = Object.fromEntries(Object.entries(environment)
                .map(([name, value]) => {
                    const slot = credentialSlots.get(name);
                    if (!slot) {
                        if (containsMarker(value, markers)) {
                            throw new Error(
                                'Managed Provider placeholder escaped an owned launch environment slot',
                            );
                        }
                        return [name, value];
                    }
                    if (value !== slot.placeholder) {
                        throw new Error(
                            'Managed Provider credential slot does not contain its exact placeholder',
                        );
                    }
                    return [name, slot.credential];
                }));
            if (!readsCurrent()) {
                throw new Error(
                    'Managed Provider launch credential authority changed during substitution',
                );
            }
            return Object.freeze(transformed);
        },
    });
}
