import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const androidJniSource = readFileSync(
  path.join(packageRoot, "android", "src", "main", "cpp", "HappierSherpaNativeJni.cpp"),
  "utf8",
);

assert.match(
  androidJniSource,
  /#include "HappierSherpaTtsJobRegistry\.h"/,
  "Android TTS must use the shared cancellation registry header",
);
assert.match(
  androidJniSource,
  /\.beginJob\(jobKey,\s*&wasAlreadyCancelled\)/,
  "Android synthesis must register jobs through the shared registry so queued cancels are consumed",
);
assert.match(
  androidJniSource,
  /\.finishJob\(jobKey\)/,
  "Android synthesis must finish jobs through the shared registry",
);
assert.match(
  androidJniSource,
  /\.cancel\(jobKey\)/,
  "Android cancel must call the shared registry so cancel-before-registration is retained",
);
assert.doesNotMatch(
  androidJniSource,
  /std::unordered_map<std::string,\s*std::unique_ptr<JobState>>\s+jobs/,
  "Android must not keep a parallel active-only TTS job map",
);
