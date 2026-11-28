type SettingsPagePresentation = typeof import('./settingsPageDeclarations');

let loadedPresentation: SettingsPagePresentation | undefined;

export function readSettingsPagePresentation(): SettingsPagePresentation | undefined {
    return loadedPresentation;
}

export async function loadSettingsPagePresentation(): Promise<SettingsPagePresentation> {
    return loadedPresentation ??= await import('./settingsPageDeclarations');
}
