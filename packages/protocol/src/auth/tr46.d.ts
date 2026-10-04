// tr46 5.1.1 is a JavaScript-only external IDNA boundary.
declare module 'tr46' {
    export function toASCII(domain: string, options?: {
        checkBidi?: boolean;
        checkHyphens?: boolean;
        checkJoiners?: boolean;
        useSTD3ASCIIRules?: boolean;
        transitionalProcessing?: boolean;
    }): string | null;
}
