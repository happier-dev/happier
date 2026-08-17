const MAX_JSON_NESTING_V1 = 64;
const INSTALLATION_ID_PATTERN_V1 = /^[1-9][0-9]{0,19}$/u;

class JsonSyntaxError extends Error {}

class RoutingJsonReader {
    private position = 0;

    constructor(private readonly source: string) {}

    readInstallationId(): string | null {
        this.skipWhitespace();
        let installationId: string | null = null;
        if (this.peek() === "{") {
            installationId = this.readTopLevelObject();
        } else {
            this.skipValue(0);
        }
        this.skipWhitespace();
        if (this.position !== this.source.length) throw new JsonSyntaxError();
        return installationId;
    }

    private readTopLevelObject(): string | null {
        this.expect("{");
        this.skipWhitespace();
        if (this.consume("}")) return null;
        let installationSeen = false;
        let installationId: string | null = null;
        while (true) {
            const key = this.readString();
            this.skipWhitespace();
            this.expect(":");
            this.skipWhitespace();
            if (key === "installation") {
                if (installationSeen) {
                    this.skipValue(1);
                    installationId = null;
                } else {
                    installationSeen = true;
                    installationId = this.peek() === "{" ? this.readInstallationObject() : (this.skipValue(1), null);
                }
            } else {
                this.skipValue(1);
            }
            this.skipWhitespace();
            if (this.consume("}")) return installationSeen ? installationId : null;
            this.expect(",");
            this.skipWhitespace();
        }
    }

    private readInstallationObject(): string | null {
        this.expect("{");
        this.skipWhitespace();
        if (this.consume("}")) return null;
        let idSeen = false;
        let installationId: string | null = null;
        while (true) {
            const key = this.readString();
            this.skipWhitespace();
            this.expect(":");
            this.skipWhitespace();
            if (key === "id") {
                if (idSeen) {
                    this.skipValue(2);
                    installationId = null;
                } else {
                    idSeen = true;
                    if (this.isNumberStart(this.peek())) {
                        const token = this.readNumber();
                        installationId = INSTALLATION_ID_PATTERN_V1.test(token) ? token : null;
                    } else {
                        this.skipValue(2);
                    }
                }
            } else {
                this.skipValue(2);
            }
            this.skipWhitespace();
            if (this.consume("}")) return idSeen ? installationId : null;
            this.expect(",");
            this.skipWhitespace();
        }
    }

    private skipValue(depth: number): void {
        if (depth > MAX_JSON_NESTING_V1) throw new JsonSyntaxError();
        this.skipWhitespace();
        const next = this.peek();
        if (next === '"') {
            this.readString(false);
            return;
        }
        if (next === "{") {
            this.skipObject(depth + 1);
            return;
        }
        if (next === "[") {
            this.skipArray(depth + 1);
            return;
        }
        if (next === "t") return this.expectLiteral("true");
        if (next === "f") return this.expectLiteral("false");
        if (next === "n") return this.expectLiteral("null");
        if (this.isNumberStart(next)) {
            this.readNumber();
            return;
        }
        throw new JsonSyntaxError();
    }

    private skipObject(depth: number): void {
        if (depth > MAX_JSON_NESTING_V1) throw new JsonSyntaxError();
        this.expect("{");
        this.skipWhitespace();
        if (this.consume("}")) return;
        while (true) {
            this.readString();
            this.skipWhitespace();
            this.expect(":");
            this.skipValue(depth);
            this.skipWhitespace();
            if (this.consume("}")) return;
            this.expect(",");
            this.skipWhitespace();
        }
    }

    private skipArray(depth: number): void {
        if (depth > MAX_JSON_NESTING_V1) throw new JsonSyntaxError();
        this.expect("[");
        this.skipWhitespace();
        if (this.consume("]")) return;
        while (true) {
            this.skipValue(depth);
            this.skipWhitespace();
            if (this.consume("]")) return;
            this.expect(",");
            this.skipWhitespace();
        }
    }

    private readString(decode = true): string {
        const start = this.position;
        this.expect('"');
        while (this.position < this.source.length) {
            const character = this.source[this.position++];
            if (character === '"') {
                if (!decode || this.position - start > 128) return "";
                try {
                    return JSON.parse(this.source.slice(start, this.position)) as string;
                } catch {
                    throw new JsonSyntaxError();
                }
            }
            if (character === "\\") {
                const escaped = this.source[this.position++];
                if (escaped === "u") {
                    const hex = this.source.slice(this.position, this.position + 4);
                    if (!/^[0-9a-fA-F]{4}$/u.test(hex)) throw new JsonSyntaxError();
                    this.position += 4;
                } else if (!escaped || !'"\\/bfnrt'.includes(escaped)) {
                    throw new JsonSyntaxError();
                }
            } else if (!character || character.charCodeAt(0) < 0x20) {
                throw new JsonSyntaxError();
            }
        }
        throw new JsonSyntaxError();
    }

    private readNumber(): string {
        const start = this.position;
        this.consume("-");
        if (this.consume("0")) {
            // A leading zero ends the integer component; a following digit is invalid JSON.
        } else {
            if (!this.isDigitOneToNine(this.peek())) throw new JsonSyntaxError();
            while (this.isDigit(this.peek())) this.position += 1;
        }
        if (this.consume(".")) {
            if (!this.isDigit(this.peek())) throw new JsonSyntaxError();
            while (this.isDigit(this.peek())) this.position += 1;
        }
        if (this.peek() === "e" || this.peek() === "E") {
            this.position += 1;
            if (this.peek() === "+" || this.peek() === "-") this.position += 1;
            if (!this.isDigit(this.peek())) throw new JsonSyntaxError();
            while (this.isDigit(this.peek())) this.position += 1;
        }
        return this.source.slice(start, this.position);
    }

    private expectLiteral(value: string): void {
        if (this.source.slice(this.position, this.position + value.length) !== value) throw new JsonSyntaxError();
        this.position += value.length;
    }

    private skipWhitespace(): void {
        while (true) {
            const value = this.peek();
            if (value !== "\t" && value !== "\n" && value !== "\r" && value !== " ") return;
            this.position += 1;
        }
    }

    private peek(): string {
        return this.source[this.position] ?? "";
    }

    private expect(value: string): void {
        if (!this.consume(value)) throw new JsonSyntaxError();
    }

    private consume(value: string): boolean {
        if (this.source[this.position] !== value) return false;
        this.position += 1;
        return true;
    }

    private isNumberStart(value: string): boolean {
        return value === "-" || this.isDigit(value);
    }

    private isDigit(value: string): boolean {
        return value >= "0" && value <= "9";
    }

    private isDigitOneToNine(value: string): boolean {
        return value >= "1" && value <= "9";
    }
}

export function extractVerifiedGitHubInstallationIdV1(rawBody: Uint8Array):
    | Readonly<{ ok: true; installationId: string }>
    | Readonly<{ ok: false; code: "malformedPayload" | "malformedInstallation" }> {
    try {
        const source = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
        const installationId = new RoutingJsonReader(source).readInstallationId();
        return installationId
            ? { ok: true, installationId }
            : { ok: false, code: "malformedInstallation" };
    } catch {
        return { ok: false, code: "malformedPayload" };
    }
}
