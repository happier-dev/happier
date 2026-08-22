import { Buffer } from 'node:buffer';

/**
 * Expands one credential into the exact text representations that may surface
 * outside a sensitive log field. Basic usernames are deliberately excluded:
 * the decoded credential and password are secret, but the username alone is
 * not host credential material.
 */
export function readCredentialRedactionValues(input: Readonly<{
    rawCredential?: string;
    authorizationValue?: string;
    maximumAuthorizationTokenBytes?: number;
}>): readonly string[] {
    const values: string[] = [];
    if (input.rawCredential) values.push(input.rawCredential);

    const authorizationValue = input.authorizationValue;
    if (authorizationValue) {
        const authorization = /^(Bearer|Basic)[ \t]+([^\s]+)$/iu.exec(
            authorizationValue,
        );
        const token = authorization?.[2];
        if (token && authorization?.[1]?.toLowerCase() === 'basic') {
            try {
                if (
                    input.maximumAuthorizationTokenBytes === undefined
                    || Buffer.byteLength(token, 'utf8')
                        <= input.maximumAuthorizationTokenBytes
                ) {
                    const decodedBytes = Buffer.from(token, 'base64');
                    if (decodedBytes.toString('base64') === token) {
                        const decoded = new TextDecoder('utf-8', {
                            fatal: true,
                        }).decode(decodedBytes);
                        const separator = decoded.indexOf(':');
                        if (separator >= 0) {
                            values.push(decoded);
                            const password = decoded.slice(separator + 1);
                            if (password.length > 0) values.push(password);
                        }
                    }
                }
            } catch {
                // Malformed or non-UTF-8 Basic material has no decoded form.
            }
        }
        if (token) values.push(token);
        values.push(authorizationValue);
    }

    return Object.freeze([
        ...new Set(values.filter((value) => value.length > 0)),
    ]);
}
