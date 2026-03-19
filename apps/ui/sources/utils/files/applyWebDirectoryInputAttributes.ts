type WebDirectoryInputTarget = {
    multiple?: boolean;
    setAttribute: (name: string, value: string) => void;
};

const WEB_DIRECTORY_ATTRIBUTES = ['webkitdirectory', 'directory'] as const;

export function applyWebDirectoryInputAttributes(input: WebDirectoryInputTarget | null): void {
    if (!input) return;
    input.multiple = true;
    for (const attribute of WEB_DIRECTORY_ATTRIBUTES) {
        input.setAttribute(attribute, '');
    }
}
