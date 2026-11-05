// These exact programs travel with the command. Observing a host must not
// require a fresh workspace or a newly synchronized worker entry point.
const identity = 'process.stdout.write("HSTACK_QA_HOST="+JSON.stringify({platform:process.platform,arch:process.arch,remote:process.env.HAPPIER_DEV_TARGET_EXECUTION==="1"})+"\\n")';
const memory = 'const cp=require("node:child_process");const result=cp.spawnSync("./apps/stack/bin/hstack-exec",["--heavyweight-memory-sample"],{encoding:"utf8"});if(result.status!==0)throw new Error("Host memory observation unavailable: "+result.stderr);process.stdout.write("HSTACK_QA_HOST="+JSON.stringify({platform:process.platform,arch:process.arch,remote:process.env.HAPPIER_DEV_TARGET_EXECUTION==="1",...JSON.parse(result.stdout)})+"\\n")';

export const HOST_OBSERVATION_PROGRAMS = Object.freeze({ identity, memory });
