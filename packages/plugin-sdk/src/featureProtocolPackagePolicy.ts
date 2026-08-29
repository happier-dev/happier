/**
 * A feature-protocol uses an ordinary canonical npm package name whose
 * package segment ends in `-protocol`. The optional npm scope belongs to the
 * package author; Happier's scope carries no additional authority.
 */
export const FEATURE_PROTOCOL_PACKAGE_NAME = /^(?=.{1,214}$)(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*-protocol$/u;
export const FEATURE_PROTOCOL_EXPORTS = ['.', './testing/v1', './v1'] as const;

export type PublicFeatureProtocolPackageManifest = Readonly<{
    name: string;
    private: false;
    exports: Readonly<Record<string, unknown>>;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isFeatureProtocolPackageName(value: unknown): value is string {
    return typeof value === 'string'
        && value.length <= 214
        && FEATURE_PROTOCOL_PACKAGE_NAME.test(value);
}

export function hasFeatureProtocolPackageExports(value: unknown): value is Readonly<Record<string, unknown>> {
    if (!isRecord(value)) return false;
    const keys = Object.keys(value).sort((left, right) => left.localeCompare(right));
    return keys.length === FEATURE_PROTOCOL_EXPORTS.length
        && keys.every((key, index) => key === FEATURE_PROTOCOL_EXPORTS[index]);
}

export function isPublicFeatureProtocolPackageManifest(
    value: unknown,
): value is PublicFeatureProtocolPackageManifest {
    if (!isRecord(value)) return false;
    return isFeatureProtocolPackageName(value.name)
        && value.private === false
        && hasFeatureProtocolPackageExports(value.exports);
}

export function publicFeatureProtocolPackageSpecifiers(value: unknown): readonly string[] {
    if (!isPublicFeatureProtocolPackageManifest(value)) return [];
    return FEATURE_PROTOCOL_EXPORTS.map((exportKey) => (
        exportKey === '.' ? value.name : `${value.name}/${exportKey.slice(2)}`
    ));
}
