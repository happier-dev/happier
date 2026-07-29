import * as semver from 'semver';

export function isAppVersionAtLeastMinimum(appVersion: string, minimumVersion: string): boolean {
    const declared = semver.valid(appVersion);
    const minimum = semver.valid(minimumVersion);
    return declared !== null && minimum !== null && semver.gte(declared, minimum);
}
