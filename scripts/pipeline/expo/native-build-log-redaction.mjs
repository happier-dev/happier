const EAS_LOCAL_BUILD_PAYLOAD = "<redacted-eas-local-build-payload>";
const EAS_LOCAL_BUILD_PLUGIN_PAYLOAD_PATTERN =
  /\beas-cli-local-build-plugin@[^\s"']+\s+([A-Za-z0-9+/_=-]{80,})(?=\s|$)/g;
const BASE64ISH_TOKEN_PATTERN = /(^|[\s"'])([A-Za-z0-9+/_=-]{80,})(?=$|[\s"'])/g;

/**
 * @param {unknown} value
 * @returns {string}
 */
function stringifyCommandArg(value) {
  const arg = String(value ?? "");
  return /\s/.test(arg) ? JSON.stringify(arg) : arg;
}

/**
 * @param {string} token
 * @returns {boolean}
 */
function isEasLocalBuildPayloadToken(token) {
  try {
    const normalized = token.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded = Buffer.from(padded, "base64").toString("utf8").trim();
    if (!decoded.startsWith("{")) return false;

    const parsed = JSON.parse(decoded);
    const job = parsed && typeof parsed === "object" ? parsed.job : null;
    return Boolean(job && typeof job === "object" && ("secrets" in job || "buildCredentials" in job));
  } catch {
    return false;
  }
}

/**
 * @param {unknown} text
 * @returns {string}
 */
export function redactNativeBuildLogText(text) {
  return String(text ?? "")
    .replace(EAS_LOCAL_BUILD_PLUGIN_PAYLOAD_PATTERN, (match, payload) =>
      match.replace(payload, EAS_LOCAL_BUILD_PAYLOAD),
    )
    .replace(BASE64ISH_TOKEN_PATTERN, (match, prefix, token) =>
      isEasLocalBuildPayloadToken(token) ? `${prefix}${EAS_LOCAL_BUILD_PAYLOAD}` : match,
    );
}

export function createNativeBuildLogRedactor() {
  let bufferedLine = "";

  return {
    /**
     * @param {unknown} chunk
     * @returns {string}
     */
    push(chunk) {
      bufferedLine += String(chunk ?? "");
      const lastNewlineIndex = bufferedLine.lastIndexOf("\n");
      if (lastNewlineIndex < 0) return "";

      const ready = bufferedLine.slice(0, lastNewlineIndex + 1);
      bufferedLine = bufferedLine.slice(lastNewlineIndex + 1);
      return redactNativeBuildLogText(ready);
    },

    /**
     * @returns {string}
     */
    flush() {
      if (!bufferedLine) return "";
      const ready = bufferedLine;
      bufferedLine = "";
      return redactNativeBuildLogText(ready);
    },
  };
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @returns {string}
 */
export function formatNativeBuildCommand(cmd, args) {
  return redactNativeBuildLogText(`${cmd} ${args.map(stringifyCommandArg).join(" ")}`.trim());
}
