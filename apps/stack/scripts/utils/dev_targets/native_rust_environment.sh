# Resolve on the worker: controller HOME/CARGO_HOME do not describe its toolchain.
# Reuse the installer location owner, without installing during dispatch.
remote_rust_environment() {
  rust_path_code='import { delimiter } from "node:path"; import { pathToFileURL } from "node:url"; const { resolveRustCargoBinDir } = await import(pathToFileURL(process.argv[2]).href); const key = Object.keys(process.env).find(key => key.toUpperCase() === "PATH") || "PATH"; process.stdout.write([resolveRustCargoBinDir(process.env), process.env[key]].filter(Boolean).join(delimiter));'
  printf 'PATH="$(node --input-type=module -e %s hstack-rust-path %s)"; export PATH; ' \
    "$(quote_remote "$rust_path_code")" \
    "$(quote_remote "$1/packages/iroh-native/scripts/ensure-rust-toolchain.mjs")"
}
