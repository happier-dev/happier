# Generated from mutagen_runtime.mjs; do not edit.
# Regenerate: node apps/stack/scripts/utils/dev_targets/native_execution_projection.mjs --write-sync-policy
classify_clean_mutagen_readiness() {
  if [ "$sync_fact_scanProblems" = 1 ] && [ "$sync_fact_scanned" = 1 ] && [ "$sync_fact_completed" = 1 ]; then
    sync_readiness=rescan
    return
  fi
  if [ "$sync_fact_scanProblems" = 1 ]; then
    sync_readiness=unhealthy
    return
  fi
  if [ "$sync_fact_cyclesValid" = 0 ]; then
    sync_readiness=synchronizing
    return
  fi
  if [ "$sync_fact_watching" = 1 ] && [ "$sync_fact_noWatch" = 1 ] && [ "$sync_fact_completed" = 0 ]; then
    sync_readiness=needs-flush
    return
  fi
  if [ "$sync_fact_scanned" = 0 ]; then
    sync_readiness=synchronizing
    return
  fi
  if [ "$sync_fact_completed" = 0 ]; then
    sync_readiness=synchronizing
    return
  fi
  sync_readiness=ready
}
