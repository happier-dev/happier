; Tauri CLI 2.12.1's template defines UpdateMode before this uninstall hook runs.
; The companion template also marks interactive version replacements as updates.
!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode = 1
    DetailPrint "Preserving desktop components during an app update."
  ${ElseIf} $EXEDIR == $INSTDIR
    ; Tauri CLI 2.12.1 predecessors invoke replacements with _?=$INSTDIR but no
    ; replacement marker. NSIS runs those in place; normal OS uninstall runs a
    ; temporary copy. Preserve components for this ambiguous advanced invocation.
    DetailPrint "Preserving desktop components during an in-place uninstall. Run explicit app component cleanup first if removing the app permanently."
  ${Else}
    nsExec::ExecToStack '"$INSTDIR\${MAINBINARYNAME}.exe" --uninstall-desktop-components'
    Pop $0
    Pop $1
    DetailPrint "$1"
    ${If} $0 == "error"
    ${OrIf} $0 == "timeout"
      StrCpy $0 1
    ${EndIf}
    ${If} $0 != "0"
      DetailPrint "Desktop component cleanup failed (exit $0). Installed files were preserved; retry uninstall."
      SetErrorLevel $0
      Abort
    ${EndIf}
  ${EndIf}
!macroend
